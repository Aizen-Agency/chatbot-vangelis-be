const { Sequelize } = require('sequelize');
const dotenv = require('dotenv');

dotenv.config();

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false
    }
  }
});

async function migrate() {
  try {
    // Add the new column
    await sequelize.query(`
      ALTER TABLE "GlobalSettings" 
      ADD COLUMN IF NOT EXISTS "knowledgeBasePdfPaths" TEXT[] DEFAULT '{}';
    `);
    
    console.log('Migration completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    await sequelize.close();
  }
}

migrate(); 