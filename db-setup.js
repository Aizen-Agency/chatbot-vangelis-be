const { Sequelize, DataTypes } = require('sequelize');
const dotenv = require('dotenv');

dotenv.config();

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

// Define relationships
ChatSession.hasMany(Message, {
  foreignKey: 'sessionId',
  sourceKey: 'sessionId'
});
Message.belongsTo(ChatSession, {
  foreignKey: 'sessionId',
  targetKey: 'sessionId'
});

async function setupDatabase() {
  try {
    // Test database connection
    await sequelize.authenticate();
    console.log('Database connection established successfully.');

    // Sync all models with the database
    // force: true will drop existing tables
    await sequelize.sync({ force: true });
    console.log('Database schema synchronized');

    // Create initial global settings
    await GlobalSettings.create({
      id: 1,
      prompt: "You are a helpful assistant.",
      knowledgeBaseSheetIds: [],
      knowledgeBaseUrls: [],
      extractionHeaders: [],
      targetSpreadsheetId: null
    });
    console.log('Initial global settings created');

    console.log('Database setup completed successfully!');
  } catch (error) {
    console.error('Error setting up database:', error);
  } finally {
    // Close the database connection
    await sequelize.close();
  }
}

// Run the setup
setupDatabase(); 