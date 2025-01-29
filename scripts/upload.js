require("dotenv").config();
console.log("Pinecone API Key:", process.env.PINECONE_API_KEY);
console.log("Pinecone Environment:", process.env.PINECONE_ENVIRONMENT);

const fs = require("fs");
const path = require("path");
const { uploadDocumentToPinecone } = require("../helpers/uploadDocuments");
const indexName = "benefits-documents";

const folderPath = "/Users/aridulchinos/Desktop/funcodingprojects/avenirmvp/backend/documents";

(async () => {
  const files = fs.readdirSync(folderPath);

  for (const file of files) {
    const filePath = path.join(folderPath, file);
    console.log(`Uploading ${file}...`);
    await uploadDocumentToPinecone(filePath, indexName);
  }

  console.log("All documents uploaded!");
})();