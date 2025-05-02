require('dotenv').config();
const { Sequelize } = require('sequelize');
const path = require('path');
const fs = require('fs').promises;

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false
    }
  }
});

async function runMigrations() {
  try {
    // Create migrations table if it doesn't exist
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS "SequelizeMeta" (
        "name" VARCHAR(255) NOT NULL PRIMARY KEY
      );
    `);

    // Get all migration files
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = await fs.readdir(migrationsDir);
    const migrationFiles = files.filter(f => f.endsWith('.js'));

    // Get already executed migrations
    const [executedMigrations] = await sequelize.query('SELECT name FROM "SequelizeMeta"');
    const executedMigrationNames = executedMigrations.map(m => m.name);

    // Run pending migrations
    for (const file of migrationFiles) {
      if (!executedMigrationNames.includes(file)) {
        console.log(`Running migration: ${file}`);
        const migration = require(path.join(migrationsDir, file));
        await migration.up(sequelize.getQueryInterface(), Sequelize);
        await sequelize.query('INSERT INTO "SequelizeMeta" (name) VALUES (?)', {
          replacements: [file]
        });
        console.log(`Completed migration: ${file}`);
      }
    }

    console.log('All migrations completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

runMigrations(); 