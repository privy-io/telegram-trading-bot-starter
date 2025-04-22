require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { PrivyClient } = require('@privy-io/server-auth');
const { Connection, PublicKey, Keypair, VersionedTransaction } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

// Initialize Solana connection
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

// Initialize Privy client
const privy = new PrivyClient(process.env.PRIVY_APP_ID, process.env.PRIVY_APP_SECRET, {
  walletApi: {
    authorizationPrivateKey: process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY
  }
});

// Initialize Telegram bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// State management for buy flow
const userStates = new Map();

// Middleware to parse JSON
app.use(express.json());

// Basic route to verify server is running
app.get('/', (req, res) => {
  res.send('Telegram Bot Server is running!');
});

// Define the path for the wallet mapping file
const walletMappingPath = path.join(__dirname, 'wallet-mappings.json');

// Function to load wallet mappings
function loadWalletMappings() {
  try {
    if (fs.existsSync(walletMappingPath)) {
      const data = fs.readFileSync(walletMappingPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error reading wallet mappings file:', error);
  }
  return {};
}

// Function to save wallet mappings
function saveWalletMappings(mappings) {
  try {
    fs.writeFileSync(walletMappingPath, JSON.stringify(mappings, null, 2));
  } catch (error) {
    console.error('Error saving wallet mappings:', error);
  }
}


// Constants for Jupiter swap
const JUPITER_ULTRA_API_URL = 'https://lite-api.jup.ag/ultra/v1';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Function to get Jupiter Ultra order
async function getJupiterUltraOrder(inputMint, outputMint, amount, taker) {
  try {
    const response = await axios({
      method: 'get',
      maxBodyLength: Infinity,
      url: `${JUPITER_ULTRA_API_URL}/order`,
      params: {
        inputMint,
        outputMint,
        amount,
        taker,
        slippageBps: 200 // 2% slippage tolerance
      },
      headers: {
        'Accept': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    console.error('Error getting Jupiter Ultra order:', error);
    throw error;
  }
}

// Function to execute Jupiter Ultra order
async function executeJupiterUltraOrder(signedTransaction, requestId) {
  try {
    const response = await axios({
      method: 'post',
      maxBodyLength: Infinity,
      url: `${JUPITER_ULTRA_API_URL}/execute`,
      data: {
        signedTransaction,
        requestId
      },
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    console.error('Error executing Jupiter Ultra order:', error);
    throw error;
  }
}

// Function to get balances using Jupiter Ultra API
async function getJupiterUltraBalances(walletAddress) {
  try {
    const response = await axios({
      method: 'get',
      maxBodyLength: Infinity,
      url: `${JUPITER_ULTRA_API_URL}/balances/${walletAddress}`,
      headers: {
        'Accept': 'application/json'
      }
    });
    console.log(response.data);
    return response.data;
  } catch (error) {
    console.error('Error getting Jupiter Ultra balances:', error);
    throw error;
  }
}

// Telegram bot commands
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;
  let walletId;
  let walletAddress;
  
  // Load existing mappings
  const walletMappings = loadWalletMappings();
  
  if (walletMappings[userId]) {
    console.log(`User ${userId} already has a wallet. Using existing wallet.`);
    walletId = walletMappings[userId];
  } else {
    console.log(`User ${userId} does not have a wallet. Creating new wallet.`);
    try {
      const {id, address, chainType} = await privy.walletApi.createWallet({chainType: 'solana'});
      walletId = id;
      walletAddress = address;
      // Add the new wallet mapping
      walletMappings[userId] = walletId;
      // Save the updated mappings
      saveWalletMappings(walletMappings);
    } catch (error) {
      console.error(`Error creating wallet for user ${userId}:`, error);
      return bot.sendMessage(msg.chat.id, 'Sorry, there was an error creating your wallet. Please try again later.');
    }
  }
  
  try {
    if (!walletAddress) {
      const wallet = await privy.walletApi.getWallet({id: walletId});
      walletAddress = wallet.address;
    }
    
    bot.sendMessage(
      msg.chat.id,
      `Welcome! Your wallet address is: ${walletAddress}\n\n` +
      `You can use this wallet to interact with the bot.`
    );
  } catch (error) {
    console.error(`Error fetching wallet for user ${userId}:`, error);
    bot.sendMessage(msg.chat.id, 'Sorry, there was an error accessing your wallet. Please try again later.');
  }
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    'Available commands:\n\n' +
    '/start - Start the bot and create a wallet\n' +
    '/wallet - Show your wallet address\n' +
    '/balance - Check your token balances\n' +
    '/buy <token_address> <amount> - Swap SOL for another token\n\n' +
    'Example:\n' +
    '/buy EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 0.1\n\n' +
    'Common token addresses:\n' +
    'USDC: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v\n' +
    'SOL: So11111111111111111111111111111111111111112'
  );
});

bot.onText(/\/wallet/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  
  // Load existing mappings
  const walletMappings = loadWalletMappings();
  
  if (walletMappings[userId]) {
    try {
      const walletId = walletMappings[userId];
      const wallet = await privy.walletApi.getWallet({id: walletId});
      bot.sendMessage(
        chatId,
        `Your wallet address is: ${wallet.address}`
      );
    } catch (error) {
      console.error(`Error fetching wallet for user ${userId}:`, error);
      bot.sendMessage(chatId, 'Sorry, there was an error accessing your wallet. Please try again later.');
    }
  } else {
    bot.sendMessage(chatId, 'You don\'t have a wallet yet. Use /start to create one.');
  }
});

// Function to get token balance
async function getTokenBalance(connection, walletAddress, tokenMint) {
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      walletAddress,
      { mint: tokenMint }
    );
    
    if (tokenAccounts.value.length === 0) {
      return 0;
    }
    
    return tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
  } catch (error) {
    console.error('Error getting token balance:', error);
    return 0;
  }
}

// Function to get SOL balance
async function getSolBalance(connection, walletAddress) {
  try {
    const balance = await connection.getBalance(walletAddress);
    return balance / 1e9; // Convert lamports to SOL
  } catch (error) {
    console.error('Error getting SOL balance:', error);
    return 0;
  }
}

// Update the balance command
bot.onText(/\/balance/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  // Check if user has a wallet
  const walletMappings = loadWalletMappings();
  if (!walletMappings[userId]) {
    return bot.sendMessage(chatId, 'Please use /start first to create a wallet.');
  }
  
  try {
    const walletId = walletMappings[userId];
    const wallet = await privy.walletApi.getWallet({id: walletId});
    const walletAddress = wallet.address;
    
    // Get balances using Jupiter Ultra API
    const balances = await getJupiterUltraBalances(walletAddress);
    
    let balanceMessage = `💰 Wallet Balance:\n\n`;
    
    // Format balances
    for (const [token, balance] of Object.entries(balances)) {
      if (balance.amount !== "0") {
        balanceMessage += `${token}: ${balance.uiAmount.toFixed(4)}\n`;
      }
    }
    
    bot.sendMessage(chatId, balanceMessage);
  } catch (error) {
    console.error('Error getting balance:', error);
    bot.sendMessage(
      chatId,
      'Sorry, there was an error fetching your balance. Please try again later.'
    );
  }
});

// Replace the buy command handler with new version
bot.onText(/\/buy (.+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const tokenMint = match[1]; // First capture group is token address
  const amount = parseFloat(match[2]); // Second capture group is amount

  // Check if user has a wallet
  const walletMappings = loadWalletMappings();
  if (!walletMappings[userId]) {
    return bot.sendMessage(chatId, 'Please use /start first to create a wallet.');
  }

  try {
    // Validate token address
    new PublicKey(tokenMint);
  } catch (error) {
    return bot.sendMessage(
      chatId,
      '❌ Invalid token address. Please enter a valid Solana token address.\n\n' +
      'Example:\n' +
      '/buy EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 0.1'
    );
  }

  // Validate amount
  if (isNaN(amount) || amount <= 0) {
    return bot.sendMessage(
      chatId,
      '❌ Please enter a valid amount of SOL (e.g., 0.1, 0.5, 1.0)\n\n' +
      'Example:\n' +
      '/buy EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 0.1'
    );
  }

  try {
    // Get wallet
    const walletId = walletMappings[userId];
    const wallet = await privy.walletApi.getWallet({id: walletId});
    const walletAddress = wallet.address;

    // Check SOL balance
    const balances = await getJupiterUltraBalances(walletAddress);
    const solBalance = balances.SOL?.uiAmount || 0;

    if (solBalance < amount) {
      return bot.sendMessage(
        chatId,
        `❌ Insufficient SOL balance.\n` +
        `You have ${solBalance.toFixed(4)} SOL but need ${amount} SOL for this swap.\n` +
        `Please try again with a smaller amount.`
      );
    }

    // Get order
    const lamports = Math.floor(amount * 1e9);
    const order = await getJupiterUltraOrder(SOL_MINT, tokenMint, lamports.toString(), walletAddress);

    // Sign the transaction
    const transaction = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
    const {signedTransaction} = await privy.walletApi.solana.signTransaction({
      walletId: wallet.id,
      transaction: transaction
    });

    bot.sendMessage(chatId, 'Transaction signed. Processing swap...');

    // Execute the order
    const executeResult = await executeJupiterUltraOrder(
      Buffer.from(signedTransaction.serialize()).toString('base64'),
      order.requestId
    );

    bot.sendMessage(
      chatId,
      `✅ Swap successful!\n` +
      `Transaction: https://solscan.io/tx/${executeResult.signature}\n` +
      `You swapped ${amount} SOL for approximately ${order.outAmount / 1e9} tokens`
    );

  } catch (error) {
    console.error('Error in buy flow:', error);
    
    if (error.message.includes('0x1771')) {
      bot.sendMessage(
        chatId,
        '❌ Swap failed due to price movement. Please try again with a smaller amount or wait a moment.'
      );
    } else if (error.response?.data?.error) {
      bot.sendMessage(
        chatId,
        `❌ Error: ${error.response.data.error}\n` +
        'Please try again with /buy <token_address> <amount>'
      );
    } else {
      bot.sendMessage(
        chatId,
        '❌ Sorry, there was an error. Please try again with /buy <token_address> <amount>'
      );
    }
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
}); 