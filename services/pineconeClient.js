require("dotenv").config();
const { Pinecone } = require("@pinecone-database/pinecone");

const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
  //controllerHostUrl: `https://${process.env.PINECONE_ENVIRONMENT}-db.pinecone.io`,
});

module.exports = pinecone;