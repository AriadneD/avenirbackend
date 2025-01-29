const pinecone = require("./services/pineconeClient");
const axios = require("axios");

// Embed a document using OpenAI API
async function embedText(text) {
  const response = await axios.post(
    "https://api.openai.com/v1/embeddings",
    {
      model: "text-embedding-ada-002",
      input: text,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.REACT_APP_OPENAI_API_KEY}`,
      },
    }
  );
  return response.data.data[0].embedding;
}

// Upsert a document into Pinecone
async function upsertDocument(indexName, documentId, text) {
  const index = pinecone.Index(indexName);
  const embedding = await embedText(text);
  
  await index.upsert([
    {
      id: documentId,
      values: embedding,
      metadata: { text },
    },
  ]);
}

// Perform similarity search in Pinecone
async function queryDocuments(indexName, queryText, topK = 5) {
  const index = pinecone.Index(indexName);
  const embedding = await embedText(queryText);

  const result = await index.query({
    topK,
    includeMetadata: true,
    vector: embedding,
  });

  return result.matches.map((match) => match.metadata.text);
}

module.exports = { upsertDocument, queryDocuments };
