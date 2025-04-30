const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const { Sequelize, DataTypes } = require('sequelize');
const http = require('http');
const socketIo = require('socket.io');
const { google } = require('googleapis');
const axios = require('axios');
const cheerio = require('cheerio');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// OpenAI configuration
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Google Sheets configuration
const credentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

const sheets = google.sheets({ version: 'v4', auth });

// PostgreSQL connection
const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false
    }
  }
});

// Chat session model
const ChatSession = sequelize.define('ChatSession', {
  sessionId: {
    type: DataTypes.STRING,
    primaryKey: true
  }
});

// Global settings model
const GlobalSettings = sequelize.define('GlobalSettings', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    defaultValue: 1
  },
  prompt: {
    type: DataTypes.TEXT,
    defaultValue: "You are a helpful assistant."
  },
  knowledgeBaseSheetIds: {
    type: DataTypes.ARRAY(DataTypes.STRING),
    defaultValue: []
  },
  knowledgeBaseUrls: {
    type: DataTypes.ARRAY(DataTypes.STRING),
    defaultValue: []
  }
});

// Message model
const Message = sequelize.define('Message', {
  role: {
    type: DataTypes.STRING,
    allowNull: false
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  timestamp: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
});

// Define relationships with explicit foreign key
ChatSession.hasMany(Message, {
  foreignKey: 'sessionId',
  sourceKey: 'sessionId'
});
Message.belongsTo(ChatSession, {
  foreignKey: 'sessionId',
  targetKey: 'sessionId'
});

// Initialize database
sequelize.sync({ force: true }) // Use force: true only in development to recreate tables
  .then(async () => {
    console.log('Database synchronized');
    // Create default global settings if they don't exist
    await GlobalSettings.findOrCreate({
      where: { id: 1 },
      defaults: {
        prompt: "You are a helpful assistant.",
        knowledgeBaseSheetIds: [],
        knowledgeBaseUrls: []
      }
    });
  })
  .catch(err => console.error('Database sync error:', err));

// Function to fetch data from Google Sheet
async function fetchSheetData(sheetId) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'A:Z', // Adjust range as needed
    });
    return response.data.values;
  } catch (error) {
    console.error('Error fetching sheet data:', error);
    throw error;
  }
}

// Function to format sheet data for context
async function formatAllSheetDataForContext(sheetIds) {
  if (!sheetIds || !sheetIds.length) return '';
  
  let allContext = 'Knowledge Base Information:\n';
  
  for (const sheetId of sheetIds) {
    try {
      const sheetData = await fetchSheetData(sheetId);
      if (sheetData && sheetData.length) {
        const headers = sheetData[0];
        const rows = sheetData.slice(1);
        
        allContext += `\nData from Sheet ${sheetId}:\n`;
        rows.forEach(row => {
          const rowData = headers.map((header, index) => `${header}: ${row[index] || ''}`).join(', ');
          allContext += rowData + '\n';
        });
      }
    } catch (error) {
      console.error(`Error fetching data from sheet ${sheetId}:`, error);
    }
  }
  
  return allContext;
}

// Function to fetch webpage content
async function fetchWebpageContent(url) {
  try {
    const response = await axios.get(url);
    const $ = cheerio.load(response.data);
    
    // Remove script and style elements
    $('script').remove();
    $('style').remove();
    
    // Get text content
    const title = $('title').text();
    const bodyText = $('body').text()
      .replace(/\s+/g, ' ')
      .trim();
    
    return {
      title,
      content: bodyText
    };
  } catch (error) {
    console.error('Error fetching webpage:', error);
    throw error;
  }
}

// Function to format webpage content for context
function formatWebpageContentForContext(webpageData) {
  return `Webpage Knowledge Base:
Title: ${webpageData.title}
Content: ${webpageData.content}`;
}

// Function to format all webpage content for context
async function formatAllWebpageContentForContext(urls) {
  if (!urls || !urls.length) return '';
  
  let allContext = 'Webpage Knowledge Base:\n';
  
  for (const url of urls) {
    try {
      const webpageData = await fetchWebpageContent(url);
      allContext += `\nContent from ${url}:\n`;
      allContext += `Title: ${webpageData.title}\n`;
      allContext += `Content: ${webpageData.content}\n`;
    } catch (error) {
      console.error(`Error fetching content from ${url}:`, error);
    }
  }
  
  return allContext;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('New client connected');

  socket.on('startChat', async () => {
    try {
      const session = await ChatSession.create({
        sessionId: socket.id
      });
      console.log('New chat session created:', session.sessionId);
    } catch (error) {
      console.error('Error creating session:', error);
    }
  });

  socket.on('typing', () => {
    socket.broadcast.emit('typing', { sessionId: socket.id });
  });

  socket.on('stopTyping', () => {
    socket.broadcast.emit('stopTyping', { sessionId: socket.id });
  });

  socket.on('message', async (data) => {
    try {
      const session = await ChatSession.findByPk(socket.id);
      if (!session) return;

      // Add user message
      await Message.create({
        sessionId: session.sessionId,
        role: 'user',
        content: data.message
      });

      // Get conversation history
      const messages = await Message.findAll({
        where: { sessionId: session.sessionId },
        order: [['timestamp', 'ASC']]
      });

      // Format messages for OpenAI
      const formattedMessages = messages.map(msg => ({
        role: msg.role,
        content: msg.content
      }));

      // Get global settings
      const globalSettings = await GlobalSettings.findByPk(1);

      // Add system prompt
      formattedMessages.unshift({
        role: 'system',
        content: globalSettings.prompt
      });

      // If global settings has knowledge base sheets, fetch and add them to context
      if (globalSettings.knowledgeBaseSheetIds && globalSettings.knowledgeBaseSheetIds.length > 0) {
        try {
          const knowledgeContext = await formatAllSheetDataForContext(globalSettings.knowledgeBaseSheetIds);
          
          // Add knowledge base context as a system message
          formattedMessages.unshift({
            role: 'system',
            content: `Additional Context:\n${knowledgeContext}`
          });
        } catch (error) {
          console.error('Error fetching knowledge bases:', error);
        }
      }

      // If global settings has webpage knowledge bases, fetch and add them to context
      if (globalSettings.knowledgeBaseUrls && globalSettings.knowledgeBaseUrls.length > 0) {
        try {
          const webpageContext = await formatAllWebpageContentForContext(globalSettings.knowledgeBaseUrls);
          
          // Add webpage context as a system message
          formattedMessages.unshift({
            role: 'system',
            content: `Additional Context:\n${webpageContext}`
          });
        } catch (error) {
          console.error('Error fetching webpage content:', error);
        }
      }

      // Emit typing indicator
      socket.emit('typing', { sessionId: 'assistant' });

      // Get response from OpenAI
      const completion = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: formattedMessages
      });

      const assistantMessage = completion.choices[0].message.content;

      // Stop typing indicator
      socket.emit('stopTyping', { sessionId: 'assistant' });

      // Save assistant's response
      await Message.create({
        sessionId: session.sessionId,
        role: 'assistant',
        content: assistantMessage
      });

      // Send response back to client
      socket.emit('response', {
        message: assistantMessage
      });
    } catch (error) {
      console.error('Error:', error);
      socket.emit('error', { message: 'An error occurred' });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Admin routes
app.get('/api/sessions', async (req, res) => {
  try {
    const sessions = await ChatSession.findAll({
      include: [{
        model: Message,
        attributes: ['id']
      }]
    });
    
    const formattedSessions = sessions.map(session => ({
      sessionId: session.sessionId,
      prompt: session.prompt,
      messages: session.Messages
    }));
    
    res.json(formattedSessions);
  } catch (error) {
    console.error('Error fetching sessions:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    // Delete all messages associated with the session
    await Message.destroy({
      where: { sessionId }
    });

    // Delete the session
    const deleted = await ChatSession.destroy({
      where: { sessionId }
    });

    if (deleted) {
      // Notify connected clients about the deletion
      io.emit('sessionDeleted', { sessionId });
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  } catch (error) {
    console.error('Error deleting session:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/prompt', async (req, res) => {
  try {
    const { prompt } = req.body;
    const globalSettings = await GlobalSettings.findByPk(1);
    
    if (!globalSettings) {
      return res.status(404).json({ error: 'Global settings not found' });
    }

    globalSettings.prompt = prompt;
    await globalSettings.save();
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating prompt:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/prompt', async (req, res) => {
  try {
    const globalSettings = await GlobalSettings.findByPk(1);
    
    if (!globalSettings) {
      return res.status(404).json({ error: 'Global settings not found' });
    }

    res.json({ prompt: globalSettings.prompt });
  } catch (error) {
    console.error('Error fetching prompt:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update knowledge base routes to handle multiple sheets and URLs
app.post('/api/knowledge-base', async (req, res) => {
  try {
    const { sheetId, action } = req.body;
    const globalSettings = await GlobalSettings.findByPk(1);
    
    if (!globalSettings) {
      return res.status(404).json({ error: 'Global settings not found' });
    }

    // Validate sheet access
    try {
      await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    } catch (error) {
      console.error('Error validating sheet access:', error);
      return res.status(400).json({ error: 'Invalid or inaccessible Google Sheet ID' });
    }

    if (action === 'add') {
      if (!globalSettings.knowledgeBaseSheetIds.includes(sheetId)) {
        globalSettings.knowledgeBaseSheetIds = [...(globalSettings.knowledgeBaseSheetIds || []), sheetId];
      }
    } else if (action === 'remove') {
      globalSettings.knowledgeBaseSheetIds = (globalSettings.knowledgeBaseSheetIds || []).filter(id => id !== sheetId);
    }

    await globalSettings.save();
    
    // Return the updated list of sheet IDs
    res.json({ 
      success: true, 
      sheetIds: globalSettings.knowledgeBaseSheetIds || [] 
    });
  } catch (error) {
    console.error('Error updating knowledge base:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/knowledge-base', async (req, res) => {
  try {
    const globalSettings = await GlobalSettings.findByPk(1);
    
    if (!globalSettings) {
      return res.status(404).json({ error: 'Global settings not found' });
    }

    // Ensure we always return an array
    const sheetIds = globalSettings.knowledgeBaseSheetIds || [];
    console.log('Returning sheet IDs:', sheetIds); // Debug log
    res.json({ sheetIds });
  } catch (error) {
    console.error('Error fetching knowledge base:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/knowledge-base-url', async (req, res) => {
  try {
    const { url, action } = req.body;
    const globalSettings = await GlobalSettings.findByPk(1);
    
    if (!globalSettings) {
      return res.status(404).json({ error: 'Global settings not found' });
    }

    // Validate URL and try to fetch content
    try {
      await fetchWebpageContent(url);
    } catch (error) {
      return res.status(400).json({ error: 'Invalid or inaccessible URL' });
    }

    if (action === 'add') {
      if (!globalSettings.knowledgeBaseUrls.includes(url)) {
        globalSettings.knowledgeBaseUrls = [...globalSettings.knowledgeBaseUrls, url];
      }
    } else if (action === 'remove') {
      globalSettings.knowledgeBaseUrls = globalSettings.knowledgeBaseUrls.filter(u => u !== url);
    }

    await globalSettings.save();
    
    res.json({ success: true, urls: globalSettings.knowledgeBaseUrls });
  } catch (error) {
    console.error('Error updating webpage knowledge base:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/knowledge-base-url', async (req, res) => {
  try {
    const globalSettings = await GlobalSettings.findByPk(1);
    
    if (!globalSettings) {
      return res.status(404).json({ error: 'Global settings not found' });
    }

    res.json({ urls: globalSettings.knowledgeBaseUrls || [] });
  } catch (error) {
    console.error('Error fetching webpage knowledge base:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});