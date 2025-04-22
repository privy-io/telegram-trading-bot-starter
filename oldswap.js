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
const JUPITER_API_URL = 'https://quote-api.jup.ag/v6';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Function to get Jupiter quote
async function getJupiterQuote(inputMint, outputMint, amount) {
  try {
    const response = await axios.get(`${JUPITER_API_URL}/quote`, {
      params: {
        inputMint,
        outputMint,
        amount,
        slippageBps: 200 // 2% slippage tolerance
      }
    });
    return response.data;
  } catch (error) {
    console.error('Error getting Jupiter quote:', error);
    throw error;
  }
}

// Function to execute Jupiter swap
async function executeJupiterSwap(quote, wallet) {
  try {
    const response = await axios.post(`${JUPITER_API_URL}/swap`, {
      quoteResponse: quote,
      userPublicKey: wallet.address,
      wrapUnwrapSOL: true,
      computeUnitPriceMicroLamports: 100000 // Add priority fee to help with execution
    });
    return response.data;
  } catch (error) {
    console.error('Error executing Jupiter swap:', error);
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
  bot.sendMessage(chatId, 'Available commands:\n/start - Start the bot\n/help - Show this help message');
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
    const walletAddress = new PublicKey(wallet.address);
    
    // Get SOL balance
    const solBalance = await getSolBalance(connection, walletAddress);
    
    let balanceMessage = `💰 Wallet Balance:\n\n`;
    balanceMessage += `SOL: ${solBalance.toFixed(4)} SOL\n`;
    
    // Check USDC balance
    const usdcMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const usdcBalance = await getTokenBalance(connection, walletAddress, usdcMint);
    if (usdcBalance > 0) {
      balanceMessage += `USDC: ${usdcBalance.toFixed(4)}\n`;
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

// Buy command handler
bot.onText(/\/buy/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  // Check if user has a wallet
  const walletMappings = loadWalletMappings();
  if (!walletMappings[userId]) {
    return bot.sendMessage(chatId, 'Please use /start first to create a wallet.');
  }

  // Initialize or reset the user's state
  userStates.set(userId, { step: 'token_address' });
  
  bot.sendMessage(
    chatId,
    'Please enter the token mint address you want to buy.\n\n' +
    'Example:\n' +
    'USDC: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v\n\n' +
    'You can find token addresses on Solscan or other Solana explorers.'
  );
});

// Handle all messages to check for buy flow
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;
  
  // Skip if not in buy flow
  if (!userStates.has(userId)) return;
  
  const state = userStates.get(userId);
  
  try {
    switch (state.step) {
      case 'token_address':
        // Validate token address
        try {
          new PublicKey(text);
          userStates.set(userId, {
            step: 'amount',
            tokenMint: text
          });
          
          bot.sendMessage(
            chatId,
            'How much SOL would you like to swap? (e.g., 0.1, 0.5, 1.0)\n\n' +
            'Note: Make sure you have enough SOL in your wallet.'
          );
        } catch (error) {
          bot.sendMessage(
            chatId,
            '❌ Invalid token address. Please enter a valid Solana token address.'
          );
        }
        break;
        
      case 'amount':
        // Validate amount
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) {
          bot.sendMessage(
            chatId,
            '❌ Please enter a valid amount of SOL (e.g., 0.1, 0.5, 1.0)'
          );
          return;
        }

        // Get wallet and check balance
        const walletMappings = loadWalletMappings();
        const walletId = walletMappings[userId];
        const wallet = await privy.walletApi.getWallet({id: walletId});
        const walletAddress = new PublicKey(wallet.address);
        
        // Check SOL balance
        const solBalance = await getSolBalance(connection, walletAddress);
        if (solBalance < amount) {
          userStates.delete(userId);
          return bot.sendMessage(
            chatId,
            `❌ Insufficient SOL balance.\n` +
            `You have ${solBalance.toFixed(4)} SOL but need ${amount} SOL for this swap.\n` +
            `Please try again with a smaller amount.`
          );
        }
        
        // Get quote
        const lamports = Math.floor(amount * 1e9);
        
        try {
          // Get quote with retries
          let quote;
          let retries = 3;
          while (retries > 0) {
            try {
              quote = await getJupiterQuote(SOL_MINT, state.tokenMint, lamports.toString());
              break;
            } catch (error) {
              retries--;
              if (retries === 0) throw error;
              await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second between retries
            }
          }
          
          // Execute the swap
          const swapResult = await executeJupiterSwap(quote, wallet);
          
          // Sign and send the transaction
          const transaction = VersionedTransaction.deserialize(Buffer.from(swapResult.swapTransaction, 'base64'));
          const startTime = Date.now();
          const {signedTransaction} = await privy.walletApi.solana.signTransaction({
            walletId: wallet.id,
            transaction: transaction
          });
          const signTime = Date.now() - startTime;
          bot.sendMessage(
            chatId,
            `Transaction signed in ${signTime}ms. Processing swap...`
          );
          
          // Send transaction with retries
          let signature;
          retries = 3;
          while (retries > 0) {
            try {
              signature = await connection.sendRawTransaction(signedTransaction.serialize());
              break;
            } catch (error) {
              retries--;
              if (retries === 0) throw error;
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
          
          // Wait for confirmation
          await connection.confirmTransaction(signature);
          
          // Clear the user's state
          userStates.delete(userId);
          
          bot.sendMessage(
            chatId,
            `✅ Swap successful!\n` +
            `Transaction: https://solscan.io/tx/${signature}\n` +
            `You swapped ${amount} SOL for approximately ${quote.outAmount / 1e9} tokens`
          );
        } catch (error) {
          console.error('Error in buy flow:', error);
          userStates.delete(userId);
          
          if (error.message.includes('0x1771')) {
            bot.sendMessage(
              chatId,
              '❌ Swap failed due to price movement. Please try again with a smaller amount or wait a moment.'
            );
          } else if (error.response?.data?.error) {
            bot.sendMessage(
              chatId,
              `❌ Error: ${error.response.data.error}\n` +
              'Please try again with /buy'
            );
          } else {
            bot.sendMessage(
              chatId,
              '❌ Sorry, there was an error. Please try again with /buy'
            );
          }
        }
        break;
    }
  } catch (error) {
    console.error('Error in buy flow:', error);
    // Clear the user's state on error
    userStates.delete(userId);
    
    if (error.response?.data?.error) {
      bot.sendMessage(
        chatId,
        `❌ Error: ${error.response.data.error}\n` +
        'Please try again with /buy'
      );
    } else {
      bot.sendMessage(
        chatId,
        '❌ Sorry, there was an error. Please try again with /buy'
      );
    }
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
}); 