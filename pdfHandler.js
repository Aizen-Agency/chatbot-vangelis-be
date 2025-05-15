const fs = require('fs').promises;
const path = require('path');
const pdf = require('pdf-parse');
const { PdfContent, GlobalSettings } = require('./db-setup');

// Function to read and process a PDF file
async function processPdfFile(filePath) {
  try {
    const dataBuffer = await fs.readFile(filePath);
    const data = await pdf(dataBuffer);
    
    const stats = await fs.stat(filePath);
    
    // Store or update the PDF content in the database
    await PdfContent.upsert({
      filePath,
      content: data.text,
      lastModified: stats.mtime
    });
    
    return data.text;
  } catch (error) {
    console.error(`Error processing PDF file ${filePath}:`, error);
    throw error;
  }
}

// Function to scan the kb_pdfs directory and process all PDFs
async function scanAndProcessPdfs() {
  const pdfDir = path.join(__dirname, 'kb_pdfs');
  
  try {
    // Create directory if it doesn't exist
    await fs.mkdir(pdfDir, { recursive: true });
    
    // Read all files in the directory
    const files = await fs.readdir(pdfDir);
    const pdfFiles = files.filter(file => file.toLowerCase().endsWith('.pdf'));
    
    // Get global settings
    const globalSettings = await GlobalSettings.findByPk(1);
    if (!globalSettings) {
      throw new Error('Global settings not found');
    }
    
    // Process each PDF file
    for (const file of pdfFiles) {
      const filePath = path.join(pdfDir, file);
      const stats = await fs.stat(filePath);
      
      // Check if we need to process this file
      const existingContent = await PdfContent.findByPk(filePath);
      if (!existingContent || existingContent.lastModified < stats.mtime) {
        await processPdfFile(filePath);
      }
      
      // Add to knowledge base if not already there
      if (!globalSettings.knowledgeBasePdfPaths.includes(filePath)) {
        globalSettings.knowledgeBasePdfPaths = [...globalSettings.knowledgeBasePdfPaths, filePath];
        await globalSettings.save();
      }
    }
    
    // Remove any PDFs from knowledge base that no longer exist
    const validPaths = globalSettings.knowledgeBasePdfPaths.filter(filePath => 
      pdfFiles.includes(path.basename(filePath))
    );
    if (validPaths.length !== globalSettings.knowledgeBasePdfPaths.length) {
      globalSettings.knowledgeBasePdfPaths = validPaths;
      await globalSettings.save();
    }
    
    return pdfFiles;
  } catch (error) {
    console.error('Error scanning PDF directory:', error);
    throw error;
  }
}

// Function to get all PDF content for chat context
async function getAllPdfContentForContext() {
  try {
    const globalSettings = await GlobalSettings.findByPk(1);
    if (!globalSettings || !globalSettings.knowledgeBasePdfPaths.length) {
      return '';
    }
    
    let allContext = 'PDF Knowledge Base:\n';
    
    for (const filePath of globalSettings.knowledgeBasePdfPaths) {
      const pdfContent = await PdfContent.findByPk(filePath);
      if (pdfContent) {
        allContext += `\nContent from ${path.basename(filePath)}:\n`;
        allContext += pdfContent.content + '\n';
      }
    }
    
    return allContext;
  } catch (error) {
    console.error('Error getting PDF content for context:', error);
    return '';
  }
}

module.exports = {
  processPdfFile,
  scanAndProcessPdfs,
  getAllPdfContentForContext
}; 