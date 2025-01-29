// backend/firebase.js

const admin = require("firebase-admin");

// Initialize Firebase Admin SDK
const serviceAccount = require("./ServiceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

module.exports = { db };
