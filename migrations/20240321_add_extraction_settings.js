'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('GlobalSettings', 'extractionHeaders', {
      type: Sequelize.ARRAY(Sequelize.STRING),
      defaultValue: []
    });

    await queryInterface.addColumn('GlobalSettings', 'targetSpreadsheetId', {
      type: Sequelize.STRING,
      allowNull: true
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('GlobalSettings', 'extractionHeaders');
    await queryInterface.removeColumn('GlobalSettings', 'targetSpreadsheetId');
  }
}; 