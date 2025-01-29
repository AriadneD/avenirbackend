const fs = require("fs");
const path = require("path");
const pinecone = require("../services/pineconeClient");
const { getOpenAIEmbedding } = require("./embeddingHelper");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const xlsx = require("xlsx");

// Helper to extract text from different document types
async function extractTextFromFile(filePath) {
  console.log(`Extracting text from file: ${filePath}`);
  const ext = path.extname(filePath);

  switch (ext) {
    case ".txt":
      return fs.readFileSync(filePath, "utf8");

    case ".pdf":
      const pdfBuffer = fs.readFileSync(filePath);
      const pdfData = await pdfParse(pdfBuffer);
      return pdfData.text;

    case ".docx":
      const docxBuffer = fs.readFileSync(filePath);
      const docxData = await mammoth.extractRawText({ buffer: docxBuffer });
      return docxData.value;

    case ".xlsx":
    case ".csv":
      const workbook = xlsx.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      return xlsx.utils.sheet_to_csv(sheet);

    default:
      throw new Error(`Unsupported file type: ${ext}`);
  }
}

// Helper to split text into chunks
function splitTextIntoChunks(text, chunkSize = 1000) {
  console.log(`Splitting text into chunks of ${chunkSize} characters...`);
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  console.log(`Created ${chunks.length} chunks.`);
  return chunks;
}

// Upload document to Pinecone
async function uploadDocumentToPinecone(filePath, indexName) {
  try {
    console.log(`Starting upload for file: ${filePath}`);

    // Step 1: Extract text from the file
    const text = await extractTextFromFile(filePath);
    console.log(`Extracted text length: ${text.length} characters`);

    // Step 2: Split text into chunks
    const chunks = splitTextIntoChunks(text);

    // Step 3: Get embeddings for each chunk
    const embeddings = [];
    for (const chunk of chunks) {
      console.log(`Getting embedding for chunk of length: ${chunk.length}`);
      const embedding = await getOpenAIEmbedding(chunk);
      embeddings.push(embedding);
      console.log(`Embedding received with ${embedding.length} values`);
    }

    // Step 4: Prepare vectors for upsert
    const vectors = chunks.map((chunk, idx) => ({
      id: `${path.basename(filePath)}-${idx}`,
      values: embeddings[idx],
      metadata: { text: chunk, source: path.basename(filePath) },
    }));
    console.log(vectors);

    console.log(`Preparing to upsert ${vectors.length} vectors to Pinecone...`);

    // Step 5: Initialize Pinecone index and upsert vectors
    const index = pinecone.Index(indexName);
    const response = await index.upsert(vectors, { namespace: "ns1" });

    console.log(`Upsert response:`, response);
    console.log(`Uploaded ${filePath} successfully!`);
  } catch (error) {
    console.error("Error uploading document:", error);
  }
}

module.exports = { uploadDocumentToPinecone };
