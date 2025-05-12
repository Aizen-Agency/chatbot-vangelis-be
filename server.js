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
    methods: ["GET", "POST"],
    allowedHeaders: ["my-custom-header"],
    credentials: true
  },
  transports: ['websocket', 'polling']
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
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file'
  ],
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
  },
  extractionHeaders: {
    type: DataTypes.ARRAY(DataTypes.STRING),
    defaultValue: []
  },
  targetSpreadsheetId: {
    type: DataTypes.STRING,
    allowNull: true
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

// Chat Variables model
const ChatVariable = sequelize.define('ChatVariable', {
  sessionId: {
    type: DataTypes.STRING,
    allowNull: false
  },
  variableName: {
    type: DataTypes.STRING,
    allowNull: false
  },
  variableValue: {
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
sequelize
  .authenticate()
  .then(() => {
    console.log('Database connection established successfully.');
    return sequelize.sync({ force: false });
  })
  .then(async () => {
    console.log('Database synchronized');
    await GlobalSettings.findOrCreate({
      where: { id: 1 },
      defaults: {
        prompt: "You are a helpful assistant.",
        knowledgeBaseSheetIds: [],
        knowledgeBaseUrls: []
      }
    });
  })
  .catch(err => {
    console.error('Unable to connect to the database:', err);
  });

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

// Function to analyze chat messages and extract variables
async function analyzeChatForVariables(sessionId) {
  try {
    // Get global settings for headers
    const globalSettings = await GlobalSettings.findByPk(1);
    const headers = globalSettings?.extractionHeaders || [];
    
    if (!headers.length) {
      console.log('No extraction headers configured');
      return {};
    }

    // Get all messages for the session
    const messages = await Message.findAll({
      where: { sessionId },
      order: [['timestamp', 'ASC']]
    });

    // Combine all messages into a single text
    const chatText = messages.map(m => m.content).join('\n');

    // Create a prompt that specifically asks for the configured headers
    const extractionPrompt = `Analyze the following chat conversation and extract information for these specific fields: ${headers.join(', ')}. 
Format the response as a JSON object where each key must exactly match one of these field names: ${headers.join(', ')}. 
If a field's information is not found in the conversation, set its value to an empty string.
Only include the specified fields in the response.`;

    // Use OpenAI to analyze the chat and extract variables
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: extractionPrompt
        },
        {
          role: "user",
          content: chatText
        }
      ],
      response_format: { type: "json_object" }
    });

    const extractedVariables = JSON.parse(completion.choices[0].message.content);

    // Log the extraction process
    console.log('Extraction Headers:', JSON.stringify(headers, null, 2));
    console.log('Extracted Variables:', JSON.stringify(extractedVariables, null, 2));

    // Verify that all headers are present in the extracted variables
    const missingHeaders = headers.filter(header => !(header in extractedVariables));
    if (missingHeaders.length > 0) {
      console.log('Adding missing headers with empty values:', missingHeaders);
      missingHeaders.forEach(header => {
        extractedVariables[header] = '';
      });
    }

    // Save extracted variables to database
    for (const [variableName, variableValue] of Object.entries(extractedVariables)) {
      await ChatVariable.create({
        sessionId,
        variableName,
        variableValue: String(variableValue)
      });
    }

    return extractedVariables;
  } catch (error) {
    console.error('Error analyzing chat for variables:', error);
    throw error;
  }
}

// Function to write extracted variables to spreadsheet
async function writeVariablesToSpreadsheet(sessionId) {
  try {
    // Get global settings
    const globalSettings = await GlobalSettings.findByPk(1);
    if (!globalSettings?.targetSpreadsheetId) {
      console.log('No target spreadsheet configured');
      return;
    }

    // Get extracted variables
    const variables = await ChatVariable.findAll({
      where: { sessionId },
      order: [['timestamp', 'DESC']]
    });

    if (!variables.length) {
      console.log('No variables to write to spreadsheet');
      return;
    }

    // Log all extracted variables
    console.log('Extracted Variables:', JSON.stringify(variables.map(v => ({
      name: v.variableName,
      value: v.variableValue
    })), null, 2));

    // Log configured headers
    const headers = globalSettings.extractionHeaders || [];
    console.log('Configured Headers:', JSON.stringify(headers, null, 2));

    // Format variables according to headers
    const rowData = headers.map(header => {
      const variable = variables.find(v => v.variableName === header);
      const value = variable ? variable.variableValue : '';
      console.log(`Header "${header}" matched with value: "${value}"`);
      return value;
    });

    // Log final row data
    console.log('Final Row Data:', JSON.stringify(rowData, null, 2));

    // Write to spreadsheet
    await sheets.spreadsheets.values.append({
      spreadsheetId: globalSettings.targetSpreadsheetId,
      range: 'Sheet1!A:Z',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        values: [rowData]
      }
    });

    console.log('Successfully wrote variables to spreadsheet');
  } catch (error) {
    console.error('Error writing to spreadsheet:', error);
  }
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
        model: "gpt-4o", 
        messages: formattedMessages
      });

      // Limit response length
      const assistantMessageRaw = completion.choices[0].message.content;
      const MAX_LENGTH = 500;
      let assistantMessage = assistantMessageRaw;
      if (assistantMessage.length > MAX_LENGTH) {
        assistantMessage = assistantMessage.slice(0, MAX_LENGTH) + '...';
      }
      console.log('Assistant message to send:', assistantMessage);

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

  socket.on('deleteSession', async (data) => {
    const sessionId = data.sessionId || socket.id;
    try {
      // Analyze chat for variables before deleting
      await analyzeChatForVariables(sessionId);
      // Write variables to spreadsheet
      await writeVariablesToSpreadsheet(sessionId);
      // Delete all messages associated with the session
      await Message.destroy({ where: { sessionId } });
      // Delete the session
      await ChatSession.destroy({ where: { sessionId } });
      console.log('Session deleted via websocket:', sessionId);
      // Optionally, emit an event back to the client if you want to confirm deletion
      socket.emit('sessionDeleted', { sessionId });
    } catch (error) {
      console.error('Error deleting session via websocket:', error);
      socket.emit('error', { message: 'Error deleting session' });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
    // Delete session and associated messages when client disconnects
    (async () => {
      try {
        // Extract variables before deleting
        await analyzeChatForVariables(socket.id);
        
        // Write variables to spreadsheet
        await writeVariablesToSpreadsheet(socket.id);

        // Delete all messages associated with the session
        await Message.destroy({
          where: { sessionId: socket.id }
        });

        // Delete the session
        await ChatSession.destroy({
          where: { sessionId: socket.id }
        });

        console.log('Session deleted on disconnect:', socket.id);
      } catch (error) {
        console.error('Error in disconnect handler:', error);
      }
    })();
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
    
    // Analyze chat for variables before deleting
    await analyzeChatForVariables(sessionId);
    
    // Write variables to spreadsheet
    await writeVariablesToSpreadsheet(sessionId);
    
    // Delete the session and its messages
    await Message.destroy({ where: { sessionId } });
    await ChatSession.destroy({ where: { sessionId } });
    
    res.json({ success: true });
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

// Get extracted variables for a session
app.get('/api/sessions/:sessionId/variables', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const variables = await ChatVariable.findAll({
      where: { sessionId },
      order: [['timestamp', 'DESC']]
    });
    
    res.json({ variables });
  } catch (error) {
    console.error('Error fetching variables:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get extraction settings
app.get('/api/extraction-settings', async (req, res) => {
  try {
    const globalSettings = await GlobalSettings.findByPk(1);
    
    if (!globalSettings) {
      return res.status(404).json({ error: 'Global settings not found' });
    }

    res.json({
      headers: globalSettings.extractionHeaders || [],
      targetSpreadsheetId: globalSettings.targetSpreadsheetId
    });
  } catch (error) {
    console.error('Error fetching extraction settings:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update extraction headers
app.post('/api/extraction-headers', async (req, res) => {
  try {
    const { headers } = req.body;
    const globalSettings = await GlobalSettings.findByPk(1);
    
    if (!globalSettings) {
      return res.status(404).json({ error: 'Global settings not found' });
    }

    console.log('Updating extraction headers:');
    console.log('Previous headers:', JSON.stringify(globalSettings.extractionHeaders || [], null, 2));
    console.log('New headers:', JSON.stringify(headers, null, 2));

    globalSettings.extractionHeaders = headers;
    await globalSettings.save();
    
    console.log('Headers updated successfully');
    
    res.json({ success: true, headers: globalSettings.extractionHeaders });
  } catch (error) {
    console.error('Error updating extraction headers:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update target spreadsheet
app.post('/api/target-spreadsheet', async (req, res) => {
  try {
    const { spreadsheetId } = req.body;
    const globalSettings = await GlobalSettings.findByPk(1);
    
    if (!globalSettings) {
      return res.status(404).json({ error: 'Global settings not found' });
    }

    // Validate sheet access
    try {
      await sheets.spreadsheets.get({ spreadsheetId });
    } catch (error) {
      console.error('Error validating sheet access:', error);
      return res.status(400).json({ error: 'Invalid or inaccessible Google Sheet ID' });
    }

    globalSettings.targetSpreadsheetId = spreadsheetId;
    await globalSettings.save();
    
    res.json({ success: true, targetSpreadsheetId: globalSettings.targetSpreadsheetId });
  } catch (error) {
    console.error('Error updating target spreadsheet:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});