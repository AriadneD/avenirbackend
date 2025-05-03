// backend/server.js
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const xlsx = require("xlsx");
const Papa = require("papaparse");
const { db } = require("./firebase");
const fs = require("fs");
const path = require("path");

const {
  collection,
  getDocs,
  doc,
  getDoc,
  getFirestore,
} = require("firebase/firestore");
const { PineconeClient } = require("@pinecone-database/pinecone");
const pinecone = require("./services/pineconeClient");
const { getOpenAIEmbedding } = require("./helpers/embeddingHelper");

require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 8080;

const allowedOrigins = [
  "http://localhost:3000",
  "https://avenir-kohl.vercel.app",
  "https://avenirbackend.onrender.com",
  "https://avenirbackend2.onrender.com",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
  })
);

app.use(express.json());

// Configure Google Search
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;
const BLS_API_KEY = process.env.BLS_API_KEY;
const BLS_API_URL = "https://api.bls.gov/publicAPI/v2/timeseries/data";

// Check onboarding status
app.get("/onboarding-status", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "User ID is required" });

  try {
    const docRef = db.collection("users").doc(userId);
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.json({ onboardingComplete: false });
    }
    const data = doc.data();
    res.json({ onboardingComplete: data.onboardingComplete || false });
  } catch (error) {
    res.status(500).json({ error: "Failed to check onboarding status" });
  }
});

// Save onboarding data
app.post("/save-onboarding-data", async (req, res) => {
  const { userId, companyName, employeeCount, locations } = req.body;
  if (!userId) return res.status(400).json({ error: "User ID is required" });

  try {
    const docRef = db.collection("users").doc(userId);
    await docRef.set(
      {
        onboardingComplete: true,
        companyName,
        employeeCount,
        locations,
      },
      { merge: true }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to save onboarding data" });
  }
});

// New /summarizesearch endpoint
app.post("/summarizesearch", async (req, res) => {
  const {
    employeeLocations,
    quarter,
    numberOfEmployees,
    naicsCode,
    planTypes,
    spd,
    contributions,
    complianceDocs,
    additionalQuestion,
  } = req.body;

  if (!employeeLocations || !quarter) {
    return res
      .status(400)
      .json({ error: "Employee Locations and Quarter are required fields." });
  }

  try {
    // 1️⃣ Dynamically create search queries
    const queries = [
      `Social Determinants of Health Challenges Relevant to ${employeeLocations} in ${quarter}`,
    ];

    // 2️⃣ Query Google Custom Search API
    const searchResults = [];
    for (const query of queries) {
      const response = await axios.get(
        `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(
          query
        )}&key=${process.env.GOOGLE_API_KEY}&cx=${process.env.SEARCH_ENGINE_ID}`
      );
      searchResults.push({
        query,
        items: response.data.items || [],
      });
    }

    // 3️⃣ Query BLS API for relevant statistics
    const blsQueries = [
      { seriesId: "LAUCN010010000000005", description: "Unemployment Rate" }, // Replace with relevant series IDs
    ];

    const blsResults = [];
    for (const blsQuery of blsQueries) {
      const response = await axios.post(BLS_API_URL, {
        seriesid: [blsQuery.seriesId],
        startyear: "2023",
        endyear: "2024",
        registrationkey: BLS_API_KEY,
      });

      const data = response.data.Results.series[0].data || [];
      blsResults.push({
        description: blsQuery.description,
        data: data.map((entry) => ({
          year: entry.year,
          period: entry.period,
          value: entry.value,
        })),
      });
    }

    // ✅ Console log the JSON stringified BLS results
    //("BLS Results:", JSON.stringify(blsResults, null, 2));

    // 4️⃣ Fetch uploaded document summaries from Firestore
    const userId = req.headers["user-id"]; // Assuming user ID is passed in headers
    const uploadedSummaries = [];

    const querySnapshot = await db
      .collection(`users/${userId}/documents`)
      .get();

    querySnapshot.forEach((doc) => {
      const data = doc.data();
      uploadedSummaries.push(`${data.name}: ${data.summary}`);
    });

    // 5️⃣ Combine all results into a single text
    const textToSummarize = `
        Search Results:
        ${searchResults
          .map((result) => result.items.map((item) => item.snippet).join("\n"))
          .join("\n")}
  
        BLS Statistics:
        ${blsResults
          .map(
            (result) =>
              `${result.description}:\n${result.data
                .map((entry) => `${entry.year} ${entry.period}: ${entry.value}`)
                .join("\n")}`
          )
          .join("\n")}
  
        Uploaded Document Summaries:
        ${uploadedSummaries.join("\n")}
      `;

    // Summarize the combined text using GPT-4o-mini
    const gptResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          {
            role: "user",
            content: `You are an expert in social determinants of health. 
              First, please read the Search results highlight the specific, quantitative key trends in SDOH that are relevant, provide sources and organization names where possible.
              Next, cross reference with relevant SDOH Bureau of Labor statistics.
              Finally, please consult the uploaded document summaries which represent internal company data, identify SDOH gaps and vulnerabilities.
              Please give your response in valid HTML markdown syntax, but please exclude the opening/closing html ticker.
              ${textToSummarize}`,
          },
        ],
        max_tokens: 3000,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.REACT_APP_OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const summary = gptResponse.data.choices[0]?.message?.content?.trim();
    //console.log(summary);
    res.status(200).json({ summary });
  } catch (error) {
    console.error("Error processing search and summarization:", error);
    res
      .status(500)
      .json({ error: "Failed to process search and summarization" });
  }
});

// Configure Multer for file uploads
const upload = multer({ storage: multer.memoryStorage() });

const Tesseract = require("tesseract.js");
const os = require("os");
const { fromBuffer } = require("pdf2pic");

app.post("/summarize", upload.single("file"), async (req, res) => {
  const file = req.file;
  const { pdfAsPPT, title, docType, summaryOption, summaryOther } = req.body;
  const blurColumns = JSON.parse(req.body.blurColumns || "[]");
  const dropColumns = JSON.parse(req.body.dropColumns || "[]");

  const anonymizeData = (data) => {
    return data.map((row) => {
      const newRow = { ...row };
      dropColumns.forEach((col) => delete newRow[col]);
      blurColumns.forEach((col) => {
        if (newRow[col]) {
          newRow[col] = Math.random().toString(36).substring(2, 10);
        }
      });
      return newRow;
    });
  };

  if (!file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  let extractedText = "";

  try {
    // If PDF
    if (file.mimetype === "application/pdf") {
      // Check if user selected "Yes, PDF is from PPT"
      if (pdfAsPPT === "yes") {
        const options = {
          density: 150,
          format: "png",
          width: 1024,
          height: 768,
          saveFilename: "page",
          savePath: "./temp-pdf-pages", // You can delete later
        };

        const savePath = path.resolve("./temp-pdf-pages");
        if (!fs.existsSync(savePath)) {
          fs.mkdirSync(savePath, { recursive: true });
        }

        const convert = fromBuffer(file.buffer, {
          density: 150,
          format: "png",
          width: 1024,
          height: 768,
          saveFilename: "page",
          savePath: savePath,
        });

        const pageCount = (await pdfParse(file.buffer)).numpages;

        extractedText = "";

        for (let i = 1; i <= pageCount; i++) {
          const result = await convert(i); // Returns { path, base64, page }
          const {
            data: { text },
          } = await Tesseract.recognize(result.path, "eng");
          extractedText += text + "\n";
        }

        // Optional: clean up image files after
        // fs.rmSync("./temp-pdf-pages", { recursive: true, force: true });
      } else {
        // Regular PDF parse
        extractedText = await pdfParse(file.buffer).then((data) => data.text);
      }
    }
    // DOCX
    // Process DOCX files
    else if (
      file.mimetype ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      extractedText = await mammoth
        .extractRawText({ buffer: file.buffer })
        .then((result) => result.value);
    }
    // Process Excel files
    else if (
      file.mimetype ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.mimetype === "application/vnd.ms-excel"
    ) {
      const workbook = xlsx.read(file.buffer, { type: "buffer" });
      const sheetName = workbook.SheetNames[0];
      let jsonData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

      if (blurColumns.length > 0 || dropColumns.length > 0) {
        jsonData = anonymizeData(jsonData);
      }

      extractedText = xlsx.utils.sheet_to_csv(
        xlsx.utils.json_to_sheet(jsonData)
      );
    }
    // Process CSV files
    else if (file.mimetype === "text/csv") {
      const csvText = file.buffer.toString("utf-8");
      let jsonData = xlsx.utils.sheet_to_json(
        xlsx.read(csvText, { type: "string" }).Sheets.Sheet1
      );

      if (blurColumns.length > 0 || dropColumns.length > 0) {
        jsonData = anonymizeData(jsonData);
      }

      extractedText = xlsx.utils.sheet_to_csv(
        xlsx.utils.json_to_sheet(jsonData)
      );
    } else {
      return res.status(400).json({ error: "Unsupported file type" });
    }

    // Next, build the “prompt” to GPT, adding summary instructions
    // example
    const customInstructions =
      summaryOption === "Other" ? summaryOther : summaryOption;

    // ======== 1. GENERATE TAG (plain text) ========
    const tagResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          {
            role: "user",
            content: `
              Please read the uploaded document and return a single-sentence tag that clearly describes its content. No preamble, just the sentence.

              Example: Summary of a multi-generational disability benefits analysis by region.

              Text to analyze:\n\n${extractedText}
            `,
          },
        ],
        max_tokens: 500,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.REACT_APP_OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const tag = tagResponse.data.choices[0]?.message?.content?.trim();

    // ======== 2. GENERATE SUMMARY (plain HTML/text) ========
    const summaryResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          {
            role: "user",
            content: `
              You are an expert in employee benefits and data analytics. Summarize the most important info from the document using the following user instruction: "${customInstructions}".

               Return a long, content-rich summary in simple HTML format. Use headers and bullet points if appropriate. Be detailed, and focus on conntent, not design.

              Text to summarize:\n\n${extractedText}
            `,
          },
        ],
        max_tokens: 2000,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.REACT_APP_OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const summary = summaryResponse.data.choices[0]?.message?.content?.trim();

    // ======== Final Return ========
    const combinedSummary = `
    <h3>🔍 AI-Generated Summary:</h3>
    ${summary}

    <hr/>

    <h3>📄 Full Plain Text of Document:</h3>
    <pre style="white-space: pre-wrap;">${extractedText}</pre>
    `;

    return res.status(200).json({ tag, summary: combinedSummary });
  } catch (error) {
    console.error("Error processing file:", error);
    return res.status(500).json({ error: "Failed to process file" });
  }
});

//New Helper Functions for Getting Documents
const getAllDocuments = async (userId) => {
  try {
    const userDocsRef = db.collection(`users/${userId}/documents`);
    const snapshot = await userDocsRef.get();

    if (snapshot.empty) {
      return [];
    }

    return snapshot.docs.map((doc) => ({
      name: doc.data().name,
      tag: doc.data().tag,
    }));
  } catch (error) {
    console.error("Error fetching documents:", error);
    throw new Error("Failed to fetch user-uploaded documents.");
  }
};

// Likewise, replace getDocumentByTag with the same style:

const getDocumentByTag = async (userId, tag) => {
  try {
    const userDocsRef = db.collection(`users/${userId}/documents`);
    const snapshot = await userDocsRef.get();

    if (snapshot.empty) {
      return null;
    }

    // find doc whose 'tag' field matches
    const matchedDoc = snapshot.docs.find((doc) => doc.data().tag === tag);
    return matchedDoc
      ? {
          name: matchedDoc.data().name,
          summary: matchedDoc.data().summary,
        }
      : null;
  } catch (error) {
    console.error("Error fetching document by tag:", error);
    throw new Error("Failed to fetch document by tag.");
  }
};

// Helper function to get user-uploaded documents from Firestore
const getUserUploadedDocuments = async (userId) => {
  try {
    const userDocsRef = db.collection(`users/${userId}/documents`);
    const snapshot = await userDocsRef.get();

    if (snapshot.empty) {
      return "No uploaded documents found.";
    }

    let documents = "";
    snapshot.forEach((doc) => {
      const { name, summary } = doc.data();
      documents += `\n---\n${name}: ${summary}`;
    });

    return documents;
  } catch (error) {
    console.error("Error fetching user documents:", error);
    throw new Error("Failed to fetch user-uploaded documents.");
  }
};

const { default: OpenAI } = require("openai");

// Helper function to query OpenAI Responses Search API
const queryGoogleSearch = async (query, message) => {
  try {
    const client = new OpenAI({
      apiKey: process.env.REACT_APP_OPENAI_API_KEY,
    });
    const prompt = `
      You are a senior expert researcher. Perform a web search for the following topics:
      "${query}" and "${message}"

      Then, list the top 5 relevant online website sources in concise bullet points.
      Do not include out of date information (older than 3 years), and prioritize newer information (as of today's date).

      For each site, please provide:

      1. The website name or source
      2. A brief snippet (2-4 sentences) summarizing the points from that site that directly answer the question

      Return only plain text, with no extraneous commentary or disclaimers.
    `.trim();

    const response = await client.responses.create({
      model: "gpt-4o-mini",
      tools: [
        {
          type: "web_search_preview",
          search_context_size: "low",
          // or user_location
        },
      ],
      input: prompt,
    });

    // Just access 'output_text'
    const resultText = response.output_text || "No relevant results found.";

    return resultText.trim();
  } catch (error) {
    console.error("OpenAI web search error:", error);
    return "No relevant results found.";
  }
};

// Helper function to dynamically load relevant domain files
const getRelevantDomainFiles = (message) => {
  const documents = {
    benefits: fs.readFileSync(
      path.join(__dirname, "uploads/benefitsReports.txt"),
      "utf8"
    ),
    compliance: fs.readFileSync(
      path.join(__dirname, "uploads/complianceDocs.txt"),
      "utf8"
    ),
    wellness: fs.readFileSync(
      path.join(__dirname, "uploads/wellnessPrograms.txt"),
      "utf8"
    ),
  };

  let relevantDocs = "";

  // Dynamically add documents based on keywords in the message
  if (/benefits|claims|enrollment/i.test(message)) {
    relevantDocs += `\n---\nBenefits Reports:\n${documents.benefits}`;
  }
  if (/compliance|regulations|legal/i.test(message)) {
    relevantDocs += `\n---\nCompliance Documents:\n${documents.compliance}`;
  }
  if (/wellness|engagement|mental health/i.test(message)) {
    relevantDocs += `\n---\nWellness Programs:\n${documents.wellness}`;
  }

  return relevantDocs || "No relevant domain expertise files found.";
};

// Helper function to read all files in the /uploads directory (old)
const readDomainExpertiseFiles = () => {
  const uploadsDir = path.join(__dirname, "uploads");
  const files = fs.readdirSync(uploadsDir);
  let content = "";

  files.forEach((file) => {
    const filePath = path.join(uploadsDir, file);
    const fileContent = fs.readFileSync(filePath, "utf8");
    content += `\n---\n${file}: ${fileContent}`;
  });

  return content;
};

// Helper function to query BLS API
const queryBLS = async () => {
  const seriesIds = ["LNS14000000", "LNS11300000"]; // Example series IDs
  const response = await axios.post(
    "https://api.bls.gov/publicAPI/v2/timeseries/data/",
    {
      seriesid: seriesIds,
      registrationkey: BLS_API_KEY,
    }
  );

  return response.data.Results.series
    .map(
      (series) =>
        `${series.seriesID}: ${series.data[0].year}-${series.data[0].periodName} - ${series.data[0].value}`
    )
    .join("\n");
};

// Get selected user uploaded documents
const getSelectedDocuments = async (userId, selectedDocs) => {
  try {
    const userDocsRef = db.collection(`users/${userId}/documents`);
    const snapshot = await userDocsRef.get();

    if (snapshot.empty) {
      return [];
    }

    let documents = [];
    snapshot.forEach((doc) => {
      if (selectedDocs.includes(doc.id)) {
        const { name, summary } = doc.data();
        documents.push(`${name}: ${summary}`);
      }
    });

    return documents;
  } catch (error) {
    console.error("Error fetching selected documents:", error);
    throw new Error("Failed to fetch selected documents.");
  }
};

const getCompanyInfo = async (userId) => {
  try {
    if (!userId) throw new Error("User ID is required");

    // Reference to the 'details' document inside 'companyinfo'
    const companyDocRef = db
      .collection("users")
      .doc(userId)
      .collection("companyinfo")
      .doc("details");
    const companyDoc = await companyDocRef.get();

    if (!companyDoc.exists) {
      console.warn(`Company info for user ${userId} does not exist.`);
      return null;
    }

    // Extracting the required fields
    const companyData = companyDoc.data();
    return {
      companyName: companyData.companyName || "Unknown Company",
      employeeCount: companyData.employeeCount || "Unknown Employee Count",
      locations: companyData.locations || [],
      industry: companyData.industry || "Unknown Industry",
      role: companyData.role || "Employee",
    };
  } catch (error) {
    console.error("Error fetching company info:", error);
    return null;
  }
};

async function performRAGQuery(query) {
  try {
    const index = await pinecone.index("benefits-documents");
    const result = await index.query({
      vector: await getOpenAIEmbedding(query),
      topK: 3,
      includeMetadata: true,
    });

    return result.matches.map((match) => match.metadata.text);
  } catch (error) {
    console.error("Error querying Pinecone:", error);
    return [];
  }
}

// Put this near the top of your file (server.js) or in a helper file
async function callOpenAI(prompt, maxTokens = 500) {
  const openaiResponse = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini", // or whichever model
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: prompt },
      ],
      max_tokens: maxTokens,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.REACT_APP_OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  return openaiResponse.data.choices[0]?.message?.content || "No response";
}

async function getRelevantLegislation(state, searchTerms) {
  const apiKey = process.env.LEGISCAN_API_KEY;
  const baseUrl = "https://api.legiscan.com/";
  const results = [];
  const statesToSearch = [state, "US"]; // You can add more like "US", "CA", "NY"...

  console.log("🔍 Starting masterlist-based search with terms:", searchTerms);

  for (const state of statesToSearch) {
    try {
      console.log(`📥 Fetching all bills from state "${state}"`);

      const res = await axios.get(baseUrl, {
        params: {
          key: apiKey,
          op: "getMasterList",
          state,
        },
      });

      const masterList = res.data?.masterlist;
      if (!masterList || typeof masterList !== "object") {
        console.warn(`⚠️ No masterlist returned for state "${state}"`);
        continue;
      }

      const allBills = Object.values(masterList).filter(
        (bill) => bill?.bill_id && bill?.title
      );

      console.log(`📚 ${allBills.length} total bills fetched from "${state}"`);

      const filteredBills = allBills.filter((bill) =>
        searchTerms.some((term) =>
          (bill.title + " " + bill.description + " " + bill.summary)
            .toLowerCase()
            .includes(term.toLowerCase())
        )
      );

      console.log(
        `✅ Found ${filteredBills.length} relevant bills in "${state}"`
      );

      for (const bill of filteredBills.slice(0, 10)) {
        results.push({
          bill_id: bill.bill_id,
          bill_number: bill.bill_number,
          title: bill.title,
          description: bill.description,
          summary: bill.summary,
          state: state,
          session: bill.session,
          last_action_date: bill.last_action_date,
        });
      }
    } catch (err) {
      console.error(`❌ Error fetching from state "${state}":`, err.message);
    }
  }

  console.log(`🧾 Total relevant results found: ${results.length}`);
  return results;
}


const getRecentMessages = async (userId, limit = 5) => {
  try {
    const userChatsRef = db.collection(`users/${userId}/chats`).orderBy("createdAt", "desc");
    const chatsSnapshot = await userChatsRef.get();

    console.log(chatsSnapshot.size);
    if (chatsSnapshot.empty) {
      console.log("Empty Snapshot");
    }

    if (chatsSnapshot.empty) return [];

    let allUserMessages = [];

    for (const chatDoc of chatsSnapshot.docs) {
      console.log("Analyzing chat: ", chatDoc);
      const messagesSnapshot = await chatDoc.ref
        .collection("messages")
        .where("sender", "==", "user")
        .orderBy("createdAt", "desc")
        .limit(limit)
        .get();

      const messages = messagesSnapshot.docs.map((doc) => ({
        content: doc.data().text,
        createdAt: doc.data().createdAt?.toDate?.() || new Date(0),
      }));

      console.log("Messages: ", messages);

      allUserMessages.push(...messages);

      // ✅ Stop early if we already have enough
      if (allUserMessages.length >= limit) break;
    }

    allUserMessages.sort((a, b) => b.createdAt - a.createdAt);
    return allUserMessages.slice(0, limit).reverse().map((m) => m.content); // oldest to newest
  } catch (error) {
    console.error("Error fetching recent user messages:", error);
    return [];
  }
};



// seasonal-insights endpoint 
app.post("/seasonal-insights", async (req, res) => {
  try {
    const { userId, role, timelineEvents } = req.body;

    if (!userId || !role || !timelineEvents || timelineEvents.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const recentMessages = await getRecentMessages(userId);

    const today = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const timelineString = timelineEvents
      .map((e) => `${e.title} on ${e.date}${e.description ? ": " + e.description : ""}`)
      .join("\n");

    const messagesString = recentMessages.length
      ? `Recent messages from user:
${recentMessages.join("\n")}`
      : "";

    const prompt = `
Today's date is ${today}, and I am a ${role} at my company. 
Tell me what I should prioritize and how I can use Avenir AI most effectively? Please return your response in 2–3 sentences. This should be based on:
- Typical time of year requirements for my job position, ${role}.
- Key (upcoming) dates I've provided you in my timeline: ${timelineString}.
- The topics around my 5 most recent chat messages: ${messagesString}

Response structure:
- 1 welcoming sentence: Today's date is [DATE], and you've been exploring [TOPICS] and [MEETING TYPES]!
- 1 sentence on priorities: Things you can focus on now are [PRIORITY].
- Use Avenir AI to [3 SPECIFIC BULLET POINTS]
- 1 encouraging concluding sentence which compliments the user's positive traits

Format: use correct HTML syntax with <ul><li> tags for the bulleted list.
Tone: Make it short, concise, and sound like a human wrote it. It should be warm, empathetic, friendly, encouraging, professional.

About Avenir AI: 
We are a domain-specific AI agent for employee benefits professionals. 
Our features include an interactive chatbot where you can ask questions and perform actions such as:
vendor question, write RFP, cost savings estimation, write an email / create an email campaign, make a survey, write a communication / proposal / paper / executive summary, create a risk profile, evaluating a point solution, help me understand external context / bigger picture / other data from external public sources, find information, patterns, or trends about my internal company claims and HRIS data, understand key measurements and metrics, suggest actions / what can I do about this issue, industry benchmarking / what are other companies similar to me doing and ask law.
    
Here's an example response:

As a Consultant in May 2025, you’ve been diving into mental health trends, diabetes vendors, and ACA. Your focus now should be prepping for your upcoming vendor and budget meetings.

Use Avenir AI to:
- Build an RFP tailored to current mental health needs.
- Estimate and present ROIs for your diabetes point solution budget discussion.
- Draft a quick summary for stakeholders on key ACA regulatory updates.

You’ve done the hard work: your sharp insights are setting you up to make a real impact.

`.trim();


    const openAIResponse = await callOpenAI(prompt, 300);
    return res.json({ insight: openAIResponse.trim() });
  } catch (error) {
    console.error("Error in /seasonal-insights:", error);
    return res.status(500).json({ error: "Failed to generate seasonal insights" });
  }
});



// Verify that chat is ok
app.post("/verify-context", async (req, res) => {
  const { originalQuestion, userReply } = req.body;

  const verificationPrompt = `
    You are an assistant helping determine if a user reply continues the original topic or changes it.

    Original Question: "${originalQuestion}"
    User's Latest Reply: "${userReply}"

    If the reply seems like it is answering the original question (giving more detail or clarifying), respond with: {"continuesOriginalTopic": true}
    If the reply seems like a new, different topic, respond with: {"continuesOriginalTopic": false}

    Only respond in this JSON format. No other text.
  `.trim();

  try {
    const openAIResult = await callOpenAI(verificationPrompt, 200);
    const cleanResult = openAIResult.trim().replace(/```json|```/g, ""); // strip markdown if OpenAI adds

    const parsedResult = JSON.parse(cleanResult);
    res.json(parsedResult);
  } catch (error) {
    console.error("Verification failed:", error);
    res.json({ continuesOriginalTopic: true }); // Default fallback: Assume continue
  }
});

// POST /chat route

app.post("/chat", async (req, res) => {
  try {
    // ---------------------------
    // STEP 0: EXTRACT USER INPUTS
    // ---------------------------
    let {
      userId,
      message,
      chatHistory,
      useWebSearch,
      selectedDocs,
      rfpContext,
    } = req.body;
    console.log("RFP Context:", rfpContext);

    if (!message) {
      return res.status(400).json({ error: "User message is required." });
    }

    // ---------------------------
    // STEP 0.5: REWORD PROMPT WITH MEMORY + CONTEXT ANCHORING
    // ---------------------------
    let lastAssistantMessage = "";
    let lastUserMessages = "";
    let memoryPrompt = "";

    if (chatHistory && chatHistory.length > 0) {
      const lastUserMessages = chatHistory
        .filter((m) => m.role === "user")
        .slice(-10)
        .map((m) => m.content);

      const lastAssistantMessage = chatHistory
        .filter((m) => m.role === "assistant")
        .slice(-1)
        .map((m) => m.content)
        .join("\n");

      const memoryPrompt = `
        You are an assistant that rewrites prompts based on past chat history.

        You are given:
        • The user's current prompt: "${message}"
        • A history of past user prompts: ${JSON.stringify(lastUserMessages)}
        • The most recent assistant response: "${lastAssistantMessage}"

        Your task is to rephrase the current prompt to be as clear, detailed, and contextually aligned as possible, following these rules:
        • Context Anchoring:
        Use past conversation history to enrich the new prompt ONLY IF the user is continuing the same topic.
        • A "same topic" continuation is indicated by similar subject matter, terminology, entities, or a logical flow from recent interactions.
        • If the user has SHIFTED to a new topic (e.g., from "mental health spend" to "ACA laws"), treat the prompt independently without incorporating prior context, DO NOT REPHRASE THE PROMPT, ONLY RETURN THE ORIGINAL MESSAGE.
        • History Order:
        Check the most recent messages first when deciding whether the current prompt follows the previous context.
        • Reformatting:
        Make the prompt maximally understandable and, if appropriate, add relevant details based on recent history.
        • Output Constraint:
        Return only the reworded, reformatted prompt. Do not include explanations or any additional text.

        Example:
        Original prompt:
        "put it in an email"
        New prompt (after reformatting based on past history):
        "I am a consultant. Our medical spend was identified to be increased by 7%. Write an email to our head of benefits to ask them how to decrease spend."

        Return ONLY the reworded prompt. NO explanations.
  `.trim();

      try {
        const rewordedPrompt = await callOpenAI(memoryPrompt, 500);
        message = rewordedPrompt.trim();
      } catch (error) {
        console.error(
          "⚠️ Error during memory prompt rewrite. Using original message.",
          error
        );
      }
    }

    console.log(memoryPrompt);
    console.log(message);

    // ============================================================
    // STEP 1: GATHER CONTEXT (USER DOCS + EXTERNAL DATA)
    // ============================================================
    const { companyName, employeeCount, locations, industry, role } =
      await getCompanyInfo(userId);
    const userDocuments = await getSelectedDocuments(userId, selectedDocs);

    if (userDocuments.length > 0) {
      const singlePrompt = `
        You are a senior expert in employee benefits.
        Your user is an employee benefits professional at a company. They are non technical.
        They have provided a document for you to analyze. Answer this question based on the document: "${message}"

        Tone: 
        Be specific, factual, and useful. 
        Focus on quantitative insights. 
        Come up with hypotheses and justifications for why you answered the question. 
        Answer in second person addressed directly to the user. 
        Avoid saying "Please find below the requested HTML format response" or anything like that.
        
        Output structure: 
        Respond in simple HTML format, use bullets when possible.

        Here is the document to analyze:
        ${userDocuments}

      `.trim();

      const docOnlyResponse = await callOpenAI(singlePrompt, 2000);
      const cleanReply = docOnlyResponse
        .replace(/```html/g, "")
        .replace(/```/g, "")
        .trim();

      return res.json({
        reply: cleanReply,
        evidence:
          "Deep research responses are not provided when asking quick questions about only a specific document. For a longer reasoning cycle, try selecting 'None' to allow your AI assistant to browse all files. ",
      });
    }

    // (A) Get user docs + build a quick chatHistory prompt if needed

    let allDocs = await getAllDocuments(userId);

    if (allDocs.length === 0) {
      allDocs = [
        {
          name: "No docs uploaded",
          tag: "n/a",
          summary: "n/a",
        },
      ];
    }

    const blsData = await queryBLS();

    // Build document listing for evidence gathering
    const docListing = allDocs.map((d) => `${d.name} (${d.tag})`).join("\n");

    const shortHistory = chatHistory
      .filter((m) => m.role === "user")
      .slice(-10)
      .map((m) => `User: ${m.content}`)
      .join("\n");

    // Get today's date
    const today = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    // =====================================================
    // STEP 2: CLASSIFY THE USER'S GOAL & RELEVANT DATA NEEDS
    // =====================================================
    const firstPrompt = `
      You are an expert in Employee Benefits and public health. 
      I have an extremely important task for you which needs to be in-depth, specific, and actionable. 
      You MUST read the entire prompt and follow the instructions with great precision.

      I am a ${role} at my company "${companyName}" which has ${employeeCount} employees, operates in ${locations}, and operates in ${industry} industry.
      Today's date is ${today}.
      I have asked you this question: "${message}".

      Your tasks:
      1. From your analysis of the question, state the user's goal in 1 sentence. Return this as "goalSentence".
      2. Determine the question type using predefined categories. Return exactly ONE letter (a-k, y, or z) under the key "questionType".
            Possible question types:
            a) Vendor question
            b) RFP question
            c) Cost savings estimation
            d) Write an email / create an email campaign
            e) Make a survey
            f) Write a communication / proposal / paper / executive summary
            g) Create a risk profile
            h) Evaluating a point solution
            i) Help me understand external context / bigger picture / other data from external public sources
            j) Find information, patterns, or trends about my internal company data
            k) Suggest actions / what can I do about this issue?
            l) industry benchmarking / what are other companies similar to me doing? 
            m) law, policy, mandate, compliance and/or coverage related question
            n) measurement, metrics, methods
            z) The question is gibberish, doesn’t make sense or it’s off topic
      3. Determine what kind of evidence is needed to provide a complete and well-supported answer that aligns with the user's goal. Choose any combination of:
          - "internal" (data from the user's company documents)
          - "external" (industry trends, benchmarks, public health or benefit data)
          - "legislation" (laws, compliance requirements)
          - or "none" if no deep research is needed.
          - Return this list under the key "evidenceTypesNeeded" as a JSON array (e.g., ["internal", "external"]).
      4. If "external" evidence is required, Based on the intent of the question, List 1-2 search terms we should use to query our external database of public information. Or, if you feel that you don't need external data to answer the question, leave it blank.
      5. If "internal" evidence is required, Based on the intent of the question, From the list of My Company Documents, List ALL of the relevant user documents that could possibly contain information relevant to the question. This is EXTREMELY important, be broad. Return their tag, which is the sentence written in parentheses () after the name. For example ${allDocs[0].tag}

      My company documents:
      ${docListing}

      Return a JSON response EXACTLY like this, no other formats:
      {
        "goalSentence": "Your single-sentence restatement of the question here.",
        "questionType": "a",
        "evidenceTypesNeeded": ["internal", "external, "legislation"],
        "ragQueries": ["term1", "term2"],
        "docTags": ["tag1", "tag2"] (the tag is NOT the title. A tag is, for example: "This data file includes employee engagement metrics related to mental health resources accessed via email communications.")
      }

      Here are some few-shot examples so you know when different requirements are needed:

      Example 1: Vendor Recommendation
      Prompt: “Can you suggest a few navigation vendors that work well for midsize companies?”

      {
        "goalSentence": "The user wants vendor recommendations for navigation solutions suitable for midsize companies.",
        "questionType": "a",
        "evidenceTypesNeeded": ["external"],
        "ragQueries": ["care navigation vendors", "navigation vendor reviews"],
        "docTags": []
      }
      Example 2: RFP Generation
      Prompt: “Write an RFP for a virtual mental health solution that includes scope, evaluation criteria, and timeline.”

      {
        "goalSentence": "The user wants to generate an RFP document for a virtual mental health solution.",
        "questionType": "b",
        "evidenceTypesNeeded": ["none"],
        "ragQueries": [],
        "docTags": []
      }

      Example 3: Company data pattern finding
      
      Prompt: "What trends exist among our employee engagement, utilization of resources, and turnover rates, especially in relation to the retention risks previously identified?"
      {
        goalSentence: 'The user seeks to analyze trends in employee engagement, resource utilization, and turnover rates in relation to identified retention risks.',
        questionType: 'j',
        evidenceTypesNeeded: [ 'internal' ],
        ragQueries: [
          'employee engagement trends in tech industry',
          'turnover rates analysis in software companies'
        ],
        docTags: [
          'Analysis of employee demographics, engagement, benefits utilization, and industry trends within a transitioning workforce.',
          'Analysis of employee engagement, performance, and growth potential across various roles in an organization.',
          'Analysis of departmental position vacancies and turnover rates across various functions.'
        ]
      }

      Example 4: Formatting Request
      Prompt: “Can you reword this benefits announcement to sound more upbeat?”
      {
        "goalSentence": "The user wants help rewording a benefits announcement with a more upbeat tone.",
        "questionType": "f",
        "evidenceTypesNeeded": ["none"],
        "ragQueries": [],
        "docTags": []
      }

      Example 5: Simple Email Draft
      Prompt: “Can you write a quick email to HR summarizing our DEI survey results?”

      {
        "goalSentence": "The user wants to draft an email summarizing internal DEI survey results.",
        "questionType": "d",
        "evidenceTypesNeeded": ["internal"],
        "ragQueries": [],
        "docTags": ["This document contains DEI survey responses collected from employees in Q1."]
      }

      Example 6: Laws & Compliance
      Prompt: “Do we need to file anything new under the CAA 2021 transparency rules?”

      {
        "goalSentence": "The user wants to understand compliance filing requirements under the CAA 2021.",
        "questionType": "m",
        "evidenceTypesNeeded": ["legislation", "external"],
        "ragQueries": [],
        "docTags": []
      }

      Example 7: Internal Benchmark
      Prompt: “Which of our departments uses the wellness stipend the most?”

      {
        "goalSentence": "The user wants to analyze internal utilization of wellness stipends by department.",
        "questionType": "j",
        "evidenceTypesNeeded": ["internal"],
        "ragQueries": [],
        "docTags": ["This dashboard tracks wellness stipend claims across departments and months."]
      }

      Example 8: Simple Survey Creation
      Prompt: “Create a quick 5-question pulse survey to ask employees about their wellness habits.”

      {
        "goalSentence": "The user wants to create a short survey to assess employee wellness habits.",
        "questionType": "e",
        "evidenceTypesNeeded": ["none"],
        "ragQueries": [],
        "docTags": []
      }

      Example 9: Industry Benchmarking
      Prompt: “What kinds of fertility benefits are most common among companies like us?”

      {
        "goalSentence": "The user wants to understand how common fertility benefits are among similar companies.",
        "questionType": "l",
        "evidenceTypesNeeded": ["external"],
        "ragQueries": ["fertility benefit adoption by employer size", "2025 benefits trends for tech industry"],
        "docTags": []
      }

      Example 10: Terminology Explanation
      Prompt: “What’s the difference between an HSA and an FSA?”

      {
        "goalSentence": "The user wants a general explanation of the differences between HSA and FSA accounts.",
        "questionType": "i",
        "evidenceTypesNeeded": ["none"],
        "ragQueries": [],
        "docTags": []
      }

     Example 11: Company Claims Trends
     Prompt: "What are the trends in our company medical claims?"
      {
        goalSentence: "The user wants to analyze trends in their company's medical claims.",
        questionType: 'j',
        evidenceTypesNeeded: [ 'internal' ],
        ragQueries: [],
        docTags: [
          'Analysis of healthcare claims by medical providers, detailing pregnancy, diabetes, cancer, metabolic, and musculoskeletal issues across various states.'
        ]
      }

    `.trim();

    const classificationResponse = await callOpenAI(firstPrompt, 1000);
    let parsedFirst;
    try {
      parsedFirst = JSON.parse(classificationResponse);
    } catch (error) {
      parsedFirst = {
        goalSentence: "Unknown goal.",
        evidenceTypesNeeded: [],
        questionType: "j",
        ragQueries: [],
        docTags: [],
      };
    }
    console.log(parsedFirst);

    // =====================================================
    // STEP 3: GATHER RELEVANT EVIDENCE (CONDITIONALLY)
    // =====================================================

    const evidenceTypes = parsedFirst.evidenceTypesNeeded || [];

    const needsInternal = evidenceTypes.includes("internal");
    const needsExternal = evidenceTypes.includes("external");
    const needsLegislation = evidenceTypes.includes("legislation");

    const skipAllEvidence = evidenceTypes.length === 0;

    // Check if RFP Context

    if (
      parsedFirst.questionType === "b" &&
      (!rfpContext || rfpContext.trim() === "")
    ) {
      console.log("🛑 Skipping RFP generation: RFP context is empty.");
      return res.json({
        questionType: "b",
        reply:
          "You selected an RFP task, but no RFP context was provided. Please tell us more details.",
        evidence: null,
        followUps: [],
      });
    }

    // Initialize holders
    let googleResults = "";
    let legiscanEvidence = "";
    let ragData = [];
    let docSummaries = [];

    // ========= EXTERNAL EVIDENCE (RAG + GOOGLE) =========
    if (
      needsExternal &&
      parsedFirst.ragQueries &&
      parsedFirst.ragQueries.length > 0
    ) {
      for (let query of parsedFirst.ragQueries) {
        const matches = await performRAGQuery(query);
        ragData.push(`\n=== RAG for [${query}]:\n${matches.join("\n\n")}`);
      }

      if (useWebSearch) {
        const firstTerm = parsedFirst.ragQueries[0];
        googleResults = await queryGoogleSearch(firstTerm, message);
      }
    }

    // ========= LEGISLATIVE EVIDENCE (LEGISCAN) =========
    const legiscanCache = new Map();
    if (needsLegislation) {
      const lawPrompt = `
      You are an agent with the task of coming up with the most relevant queries to call the LegiScan API. 
      Your goal is to find the most relevant laws to answer this question: "${message}".
      I am a ${role}. If needed here's some additional context about my company so you can find more relevant laws for me: my company has ${employeeCount} employees, operates in ${locations}, and operates in ${industry} industry.
      Today's date is ${today}.

      First, provide the state which to search.
      Next, provide queries to search. Queries should be a mixture of simple words and phrases. Only include words/phrases that are likely to come up in the description or title of a bill. 
      They should not contain state names. 
      Return 1 state.
      Return 3 queries.
      Do not return empty response.
      
      Return a JSON response EXACTLY like this, no other formats. Do not return\\\json or any other characters:
        {
          "state": "state 1" Always use state two letter abbreviation, e.g. MA",
          "lawQueries": ["first query", "second query"]
        }
      
      
  `.trim();

      const lawResponse = await callOpenAI(lawPrompt, 1000);
      let lawResults;
      try {
        lawResults = JSON.parse(lawResponse);
      } catch {
        lawResults = { state: "", lawQueries: [] };
      }

      const legiscanResults = await getRelevantLegislation(
        lawResults.state,
        lawResults.lawQueries
      );

      if (legiscanResults.length > 0) {
        legiscanEvidence =
          "\n\nLegiScan Bills:\n" +
          legiscanResults
            .map(
              (bill, i) =>
                `${i + 1}. Bill Title: ${bill.title}
            Bill ID: ${bill.bill_id}
            Bill Number: ${bill.bill_number}
            Bill State: ${bill.state}
            Bill Description: ${bill.description}
            Last Action Date: ${bill.last_action_date}
            URL: ${bill.url || "undefined"}
            \n\n`
            )
            .join("<br /><br />");
      }
    }

    // ========= INTERNAL DOCUMENT EVIDENCE =========
    if (
      needsInternal &&
      parsedFirst.docTags &&
      parsedFirst.docTags.length > 0
    ) {
      for (let tag of parsedFirst.docTags) {
        const docData = await getDocumentByTag(userId, tag);
        if (docData) {
          docSummaries.push(
            `DOC NAME: ${docData.name}\nSUMMARY: ${docData.summary}`
          );
        }
      }
    }

    // ========= EVIDENCE COMPILATION =========
    let compiledEvidence = "";
    if (needsExternal && ragData.length > 0) {
      compiledEvidence += `External/Public Data:\n${ragData.join("\n\n")}\n\n`;
      if (googleResults)
        compiledEvidence += `Google Search Results:\n${googleResults}\n\n`;
    }

    if (needsInternal && docSummaries.length > 0) {
      compiledEvidence += `Documents from My Company:\n${docSummaries.join(
        "\n\n"
      )}\n\n`;
    }

    if (needsLegislation && legiscanEvidence) {
      compiledEvidence += `Relevant Laws & Legislation:\n${legiscanEvidence}\n\n`;
    }

    console.log(compiledEvidence);

    // =====================================================
    // STEP 4: SELECT RESPONSE TEMPLATE
    // =====================================================
    const secondPrompts = {
      a: `

          Suggest 3 point solution vendors (businesses) to target the issues stated above 
          IMPORTANT! Only suggest real vendors that exist in real life.
          Do not make up fake vendors, do not hallucinate, do not give generic responses like "Vendor A".
          Give extremely specific expert vendors tailored to the circumstance. 
          In a table, evaluate the vendors by name (with a clickable href URL to their website), features, cost, engagement, NPS, user feedback, integration.
          After the table, create a matrix of categories to score the vendors, then assign a final score with justification, and highlight the top vendor.
      `,
      b: `
          First, ignore the message that the user sent. Instead, read & follow these instructions to get the context for what I want you to do:
          ${rfpContext}

          Next, decide what type of response is best: (1) Full RFP (2) Specific Section of an RFP, ie: scope of work (3) Set of RFP Questions for Vendors (4) RFP Response
          
          (1) If it's a full RFP, imagine you are a head of benefits issuing this RFP, be as detailed as possible and write up the following sections:
            - Introduction
            - Scope of Work
            - Vendor Requirements
            - Proposal Guidelines
            - Evaluation Criteria
            - Timeline

          (2) If it's a section of an RFP, imagine you are a head of benefits issuing this RFP, be as detailed as possible and write up the full section they specified.

          (3) If it's a set of questions, imagine you are a head of benefits issuing this RFP, be detailed as possible and come up with 10+ questions from these categories: 
            - Company Overview	Years in business, funding status, major clients
            - Solution Fit	Core features, customizations, integrations
            - Implementation	Timeline, project management, training
            - Support & SLA	Support hours, escalation paths
            - Security & Compliance	Certifications, data encryption practices
            - Pricing	Detailed breakdown of all costs
            - Roadmap	Planned future enhancements
            - References	Case studies or client references

          (4) If it's an RFP response, imagine you are a consultant, and the goal is to make it extremely easy for the buyer to say yes to you. Adhere to the following guidelines:
            - Follow every instruction exactly
            - Write like you understand them better than the competition
            - Make your strengths quantifiable and obvious
            - Keep it clean, crisp, and easy to read
            - End on a positive, confident tone (you want them excited to work with you)
      `,
      c: `
          
          Use scientific, mathematical, and financial equations to state the quantifiable, specific, 
          numerical breakdown of cost savings and ROI estimation with justifications that reflects the situation above.

      `,
      d: `

          Write a highly personalized email that’s professional and concise which responds to the situation above.

      `,
      e: `

          Generate a valid HTML survey which addresses the situation above 
          (valid in the sense that checkboxes should be clickable, input forms should be real text input, etc.).

      `,
      f: `

          Generate a detailed communication that serves the goal of the situation above.

      `,
      g: `
        Come up with a Risk profile workflow based on the provided company size (${employeeCount} employees) 
        and areas of operation (${locations}) that is able to predict and forecast clinical risk. 

        First, Search the external evidence AND these sources to gather evidence to build the risk profiles, be sure to include source names.
          1. state/federal public health data
          2. legislation/regulatory data
          3. benefits trends
          4. bureau of labor statistics
          5. Industry benchmark data
          
        Next Come up with a Risk profile workflow based on the provided company size (${employeeCount} employees) and areas of operation (${locations}) that is able to predict and forecast clinical risk which includes sections on these following parts: 
        (1) Persona analysis - segment employees into different named groups based on age, tenure, generation (different groups have different needs) and state the percentage of employees belonging to each group 
        (2) SDOH - Segment employees further based on their states/geographic areas, and specifically identify the SPECIFIC risks for each state in the Deprivation index: Income, Employment, Education, Housing, Health, Access to Services, Crime 
        (3) Perform a Clinical risk forecast for each group 
        (4) Hypotheses
        (5) Suggested Benefits targeting - recommend specific benefits within that population 
        (6) KPIs - identify which success metrics we can use to monitor 

`,
      h: `

Construct a structured point solution evaluation report as follows (PLEASE ONLY INCLUDE THESE FOLLOWING SECTIONS):

        Each of the following categories should contain 3-5 detailed, specific, accurate bullet points EACH, that answer the following questions:
          1. Identify Needs – Based on the provided company size (${employeeCount} employees) and areas of operation (${locations}), and assuming a self-insured company, please SPECIFICALLY identify how this point solution performs and fulfills the gaps in current benefits. (Be specific and quantitative, give a score for each category and justification)
          2. HR & Implementation Support – Is there smooth onboarding, dedicated account managers, and minimal admin burden?
          3. Integration Capabilities – Is there compatibility with existing benefits, TPAs, and data-sharing systems?
          4. Data & Insights – "What are this point solution's data sources, analytics, update frequency, and compliance (HIPAA, GDPR)?"
          5. Member Experience – Evaluate usability, engagement methods (SMS, app), and user feedback.
          6. Customer Support – Is there live support availability, response times, and how are the customer satisfaction ratings?
          7. ROI & Outcomes – Using accurate mathematical equations, calculate cost savings, and quantify clinical impact, reporting capabilities, and behavioral changes.
          8. Scalability & Innovation – "How is the long-term adaptability, vendor growth, and future-proofing?"
          9. Scoring Matrix - Construct a scoring matrix that compares this point solution to other competing vendors in 3-5 various criteria areas (THESE OTHER VENDORS MUST BE REAL VENDORS, WITH CLICKABLE URLS)
          10. Final score - Assess the quality of the point solution on a score of 1/10
          FOR ALL SECTIONS IT IS EXTREMELY IMPORTANT THAT YOU NEED TO BE SPECIFIC, DETAILED, AND ACCURATE, OR YOU WILL LOSE YOUR JOB. DO NOT INCLUDE ADDITIONAL SECTIONS. ONLY 1-10 LISTED!!!

      `,
      i: `
          First, do Data mining: Search the external sources to gather evidence and answer my question.

          1. Context & Landscape:
            What is the current state of this topic? Include relevant macro trends, industry benchmarks, recent regulations, and any historical context that shapes how we should think about this today.

          2. Implications for Employers:
            What does this mean for employers like us? Speak directly to implications on cost, compliance, equity, benefit design, employee satisfaction, or risk. Be as specific as possible.

          3. Examples & Comparisons:
            Share relevant case studies, examples, or analogies (real ones, not made up). Compare across industries or regions when useful. Highlight both successes and common pitfalls.

          4. Forward-Looking Recommendations:
            What should we be doing now or preparing for in the next 6–18 months? Offer bold but reasonable suggestions—policy design ideas, areas to monitor, or decisions to start planning for.

        Make your tone strategic and data-driven, like you're advising a senior HR or finance leader. Avoid generic phrasing or filler. Support claims with evidence or citations when available.

      `,
      j: `
      
      You are a senior analyst reviewing internal company documents to answer a complex question about employee engagement, resource utilization, and turnover.

Your task is to deliver a **deep, multi-document analytical narrative** with specific, quantitative insights.

Follow these steps:


1. Data Mining: Examine all relevant company documents to identify metrics related to the question.
   - Extract specific statistics (percentages, rates, counts, benchmarks).
   - Note differences and similarities (e.g., departments, roles, employee segments)

2. Pattern Detection: Identify cross-document trends and relationships.
   - Where do high X and low Y overlap? Or high X and high Y overlap?
   - Are there correlations between external drivers and internal data?
   - Use concrete examples: "In Document A, Sales had a 14% turnover rate and also the lowest engagement score."

3. Causal Hypotheses: Explain why you think the trends exist.
   - Offer at least 2 hypotheses with reasoning based on the data.
   - Include confounders, if applicable (e.g., tenure, department size, benefits access).

4. Recommendations:
   - Based on the findings, suggest 3+ specific actions.
   - Each action should be linked to the evidence and include expected impact (e.g., “Implement mentorship in R&D: may reduce turnover by 12%”).
   
    Tone: Professional, logical, fluent. Avoid generalities. Use real metrics when available.
    Start with a short narrative paragraph summarizing the big picture.


            `,
      k: `
      
      Respond in a structured way as follows.

      First, tell me what you see: trends, correlations, multi-document insights etc...
      Then, give Actionable Suggestions: give me (bullets) of 4 actionable suggestions.
      - Each should have a priority (High, medium, low))
      - Each should have a quantifiable, specific, numerical breakdown of cost savings and ROI estimation with justifications.
      - Each should have a short description of what it is.
      - They should also include estimated implementation timeline & steps.
      - Also, they should be ranked by feasibility of implementation. 
      - Actions could include, recommend a vendor, draft an email campaign, design a survey, etc. Get creative.
      
      - At the end, you must include real financial modeling equations & variable breakdowns with specific input variables of how you calculated cost savings and ROI.

      IMPORTANT, use the sources below to construct your answer in a tailored specific way to the company's top medical spends.

            `,
      l: `

          Imagine you're the CEO of a company similarly sized, located, and industry as mine. (Make sure you mention in the response that you are basing this on companies similar SIZE and INDUSTRY). You are giving me advice. 
          How would you tackle this issue, what strategies would you employ, what are some things companies similarly sized/industry to me have done successfully?
          Your response should be technical, professional, objective, and in 3rd person passive.

      `,
      m: `
        State the most up-to-date laws, regulations, and state-specific mandates that are relevant to answer the user's question. 
        For each law, list in bullet points the bill name, ID, description, the date it was introduced, the state it applies to, the URL (if applicable), and a justification. 
        Order the laws starting from the most recent one, as of today's date.
        Next, conduct a gap analysis to help them assess whether their plans meet legal requirements. 
        After that, make sure you list any relevant required filings & forms.
        Finally, If there are potential compliance risks, suggest specific actions to address them.

        ${
          legiscanEvidence
            ? `Relevant Laws & Legislation:\n${legiscanEvidence}`
            : ""
        }
        ${googleResults ? `\n${googleResults}` : ""}

      `,
      n: `
        1. List the methods/metrics/measures relevant to my question
        2. Critique the methods you have listed
        3. Adoption plan for new ones
        4. 2-3 actions to take / next steps, ranked by feasibility
      `,
      z: `

      This question doesn’t make sense or is off topic. 
      Please ask the user for clarification.
      `,
    };

    let secondPromptBody =
      secondPrompts[parsedFirst.questionType] || secondPrompts["j"];

    const secondPrompt = `
      You are an expert in employee benefits. 
      I am a ${role} at my company "${companyName}" which has ${employeeCount} employees, operates in ${locations}, and operates in ${industry} industry.
      Today's date is ${today}.
      I have asked you this question: "${message}".

      First, Directly amswer my question qiestopm  (Brief & Specific): In 2–3 sentences, answer my question directly with confidence and clarity. This should be about 20% of your reply.

      Next, continue the question's answer by following these instructions, which should take up the remaining 80% of your reply:

      ${secondPromptBody}

      Response format:
      - For each claim you make, be sure to back it up with a source. Use Vancouver style citations (In Vancouver style: Citations are numbered sequentially in the text using square brackets like [1]. The reference list is numbered in the same order and usually appears at the end under “References.”)
      - Do not include out of date information (older than 2 years), and prioritize newer information (as of today's date).
      - Provide your response in valid HTML syntax ONLY!! Only use valid tags & formatting <>, other than that, use plain text.
      - Do not include the characters \
      - Use FontAwesome icons for visual structuring.
      - use <h4> for headings and <p> for regular text, don't make titles too big.
      - You can color text headings and icons with #007bff and #6a11cb.
      - Long, detailed answers are preferred over vague bullets.
      - Ensure tables are mobile responsive, and have grid lines.

      ${compiledEvidence ? `Evidence:\n${compiledEvidence}` : ""}
      
      ${
        lastAssistantMessage
          ? `Here is the previous response provided by the assistant:\n"${lastAssistantMessage}"`
          : ""
      }

      After that, list the names of each reference you used (internal, external, etc.) in Vancouver style bullets. If the source has a URL, provide it and make sure it's a clickable link, but if there is no URL, do not provide one. 

      At the very end of your response, generate exactly two follow-up questions in the JSON format provided below (do not include a heading).
      These questions must be:
      - a logical next step that predicts what the user might ask next
      - highly detailed
      - relevant to the types of inquiries we can answer (Vendor selection, RFP question, Cost savings estimation, Write an email, Write a communication, Make a survey, Create a risk profile, Evaluating a point solution, Understanding benefits trends, etc.)
      - they must be directed at the bot, NOT the user

      IMPORTANT: Your follow up questions must only contain valid JSON. Do not include any other text, explanations, or symbols.

      Return the follow-up questions using the EXACT JSON format below, without adding any markdown, extra characters, or explanation:
      STRICT RULES:

      Only return JSON. No preamble, no text before or after.
      Ensure the JSON is syntactically correct and valid.
      Do not insert Markdown formatting in the actual response.
      Do not change the JSON structure.
      Failure to follow this format will result in an invalid response.
      
      json
      { "followUps": ["Follow-up question 1?", "Follow-up question 2?"] }
      

      Do not use any other formats, characters, or symbols.

    `.trim();

    const finalResponse = await callOpenAI(secondPrompt, 3500);
    let botReply = finalResponse.replace(/```html/g, "").replace(/```/g, "");

    let followUps = [];
    const lastOpenBrace = botReply.lastIndexOf("{");
    const lastCloseBrace = botReply.lastIndexOf("}");

    if (
      lastOpenBrace !== -1 &&
      lastCloseBrace !== -1 &&
      lastOpenBrace < lastCloseBrace
    ) {
      try {
        // Extract potential JSON part
        const jsonPart = botReply
          .slice(lastOpenBrace, lastCloseBrace + 1)
          .trim();

        // Parse it as JSON
        const parsedJson = JSON.parse(jsonPart);

        // Assign follow-ups if available
        followUps = parsedJson.followUps || [];

        // Remove the matched JSON string from botReply
        botReply = botReply.slice(0, lastOpenBrace).trim();
      } catch (err) {
        console.error("Error parsing follow-ups:", err);
      }
    }

    let summarizedCompiledEvidence =
      "No additional deep research evidence was required for this response.";

    // Only summarize if there is meaningful evidence
    if (compiledEvidence.trim().length > 0) {
      const summaryPrompt = `
          Summarize the following content in the style of a benefits consultant in employee benefits & public health.
          Use a formal, structured, and precise tone, suitable for inclusion in a research paper.
          Include quantitative (numerical, statistical) insights as well as qualitative ones.
          Be as specific as possible.
          At the beginning of the response, explain what this evidence summary is for, in first person ("I used [sources] to provide deep research to gather evidence to answer your question").
          At the beginning of each point, use a short phrase as the "title" of that point (on the same line, separated by a colon), so it's easier to read. At the end of each point, use Vancouver citations (brackets with numbers like "[1]" that correspond to reference numbers in the list of sources at the end)
          At the end, include the list of the names of the article sources in valid Vancouver Citation format, (and for company documents, the name of the document, MAKE SURE YOU INCLUDE THE MY COMPANY DOCUMENTS TOO!! THEY ARE IMPORTANT!).
          Do not return any extra commentary or conclusion.

          ${docSummaries ? ` Documents from My Company: \n${docSummaries}` : ""}

          ${ragData ? ` External Data: \n${ragData}` : ""}
          
          ${googleResults ? `Google Search Results:\n${googleResults}` : ""}

          ${
            legiscanEvidence
              ? `Relevant Laws & Legislation:\n${legiscanEvidence}`
              : ""
          }

          Summarized Insights (Return in PLAIN TEXT, no bold font, bullet points only):
  `.trim();

      const summarizedResponse = await callOpenAI(summaryPrompt, 1000);
      summarizedCompiledEvidence = summarizedResponse
        .replace(/```/g, "")
        .trim();
    }

    // Final response
    return res.json({
      questionType: parsedFirst.questionType,
      reply: botReply,
      evidence: summarizedCompiledEvidence,
      followUps,
    });
  } catch (error) {
    console.error("Error handling chat request:", error);
    return res.status(500).json({ error: "Failed to process chat request." });
  }
});

app.post("/bargraph", async (req, res) => {
  const { userId, message, useWebSearch, selectedDocs } = req.body;

  if (!message) {
    return res.status(400).json({ error: "User message is required." });
  }

  try {
    let documents = [];

    // Step 1: Fetch selected documents only if they exist
    if (selectedDocs && selectedDocs.length > 0) {
      documents = await getSelectedDocuments(userId, selectedDocs);
    }

    let googleResults = "";
    if (useWebSearch) {
      // Or you could combine them with commas, or do multiple searches
      googleResults = await queryGoogleSearch(message, "statistical trends");
    }

    // Step 2: Prepare the GPT prompt to generate a bar graph
    const gptPrompt = `
      You are an expert data assistant. The user wants to generate a bar graph based on their message: "${message}". 

      If there is no data provided, use your expert knowledge to fill in the graph as accurately as possible.
      No matter what, generate something!

      Format your response as structured JSON like this:

      {
        "title": "Graph Title",
        "xAxisLabel": "X Axis Label",
        "yAxisLabel": "Y Axis Label",
        "labels": ["Label1", "Label2"],
        "values": [Value1, Value2],
        "bullets": [
          "What the graph shows",
          "What all labels for axes and values mean",
          "Data source or origin"
        ]
      }

      FORMAT YOUR RESPONSE ONLY AS VALID JSON. NO COMMENTS. NO OTHER THINGS. ONLY VALID JSON. IMPORTANT!!!
      
      ${
        documents.length > 0
          ? `Extract relevant data from this document to graph: ${JSON.stringify(
              documents
            )}`
          : ""
      }

      ${
        googleResults
          ? `Extract relevant data from web search results to graph:\n${googleResults}`
          : ""
      }
    `;

    // Step 3: Call GPT to generate the bar graph JSON
    const gptResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: gptPrompt },
        ],
        max_tokens: 500,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.REACT_APP_OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Step 4: Extract JSON from the response
    const responseText = gptResponse.data.choices[0]?.message?.content || "";
    //console.log(responseText);
    // Use regex to extract valid JSON from the response
    const jsonMatch = responseText.match(/{[\s\S]*}/);
    if (!jsonMatch) {
      throw new Error("No valid JSON found in GPT response");
    }

    const graphData = JSON.parse(jsonMatch[0]);
    //console.log(graphData);
    // Step 5: Return the graph data to the frontend
    res.json({
      reply: graphData.bullets?.join("\n\n") || "Here's your line graph!",
      graphData,
    });
  } catch (error) {
    console.error("Error generating bar graph:", error);
    res.status(500).json({ error: "Failed to generate bar graph" });
  }
});

app.post("/linegraph", async (req, res) => {
  const { userId, message, useWebSearch, selectedDocs } = req.body;

  if (!message) {
    return res.status(400).json({ error: "User message is required." });
  }

  try {
    let documents = [];

    // Step 1: Fetch selected documents only if they exist
    if (selectedDocs && selectedDocs.length > 0) {
      documents = await getSelectedDocuments(userId, selectedDocs);
    }

    let googleResults = "";
    if (useWebSearch) {
      // Or you could combine them with commas, or do multiple searches
      googleResults = await queryGoogleSearch(message, "statistical trends");
    }

    // Step 2: Prepare the GPT prompt to generate a line graph
    const gptPrompt = `
     You are an expert data assistant. The user wants to generate a line graph based on this request: "${message}".

      If no user data is provided, intelligently infer it using realistic values. Always return:
      - A complete JSON with a valid graph
      - Descriptive title
      - Proper axis labels
      - 3 bullet points explaining:
        1. What the chart shows
        2. What the axis labels mean, as specifically as possible for example is it cost in millions of dollars? hundreds of dollars?
        3. The exact source of the information, provide the URL if possible, either from documents, the web, or your own knowledge

      Strictly return only this JSON format (no comments, no prose):

      {
        "title": "Graph Title",
        "xAxisLabel": "X Axis Label",
        "yAxisLabel": "Y Axis Label",
        "labels": ["2018", "2019", "2020", "2021", "2022", "2023"],
        "datasets": [
          {
            "label": "GLP-1 Drug Prescriptions",
            "data": [5000, 8000, 12000, 18000, 25000, 35000],
            "borderColor": "rgb(75, 192, 192)",
            "backgroundColor": "rgba(75, 192, 192, 0.2)"
          },
          {
            "label": "Market Growth Rate (%)",
            "data": [10, 15, 20, 25, 30, 35],
            "borderColor": "rgb(255, 99, 132)",
            "backgroundColor": "rgba(255, 99, 132, 0.2)"
          }
        ],
        "bullets": [
          "GLP-1 prescriptions have seen exponential growth, indicating rising demand for metabolic disease treatments.",
          "The chart also tracks consistent market expansion, highlighting sustained investment interest.",
          "Data is from the 2024 SHRM report https://shrm.org."
        ]
      }

      FORMAT YOUR RESPONSE ONLY AS VALID JSON. NO COMMENTS. NO OTHER THINGS. ONLY VALID JSON. IMPORTANT!!!
      
      ${
        documents.length > 0
          ? `Extract relevant data from this document to graph: ${JSON.stringify(
              documents
            )}`
          : ""
      }

      ${
        googleResults
          ? `Extract relevant data from web search results to graph:\n${googleResults}`
          : ""
      }
    `;

    // Step 3: Call GPT to generate the line graph JSON
    const gptResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: gptPrompt },
        ],
        max_tokens: 700,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.REACT_APP_OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Step 4: Extract JSON from the response
    const responseText = gptResponse.data.choices[0]?.message?.content || "";
    //console.log(responseText);
    // Use regex to extract valid JSON from the response
    const jsonMatch = responseText.match(/{[\s\S]*}/);
    if (!jsonMatch) {
      throw new Error("No valid JSON found in GPT response");
    }

    const graphData = JSON.parse(jsonMatch[0]);
    //console.log(graphData);

    // Step 5: Return the graph data to the frontend
    res.json({
      reply: graphData.bullets?.join("\n\n") || "Here's your line graph!",
      graphData,
    });
  } catch (error) {
    console.error("Error generating line graph:", error);
    res.status(500).json({ error: "Failed to generate line graph" });
  }
});

app.post("/piechart", async (req, res) => {
  const { userId, message, useWebSearch, selectedDocs } = req.body;

  if (!message) {
    return res.status(400).json({ error: "User message is required." });
  }

  try {
    let documents = [];

    // Step 1: Fetch selected documents only if they exist
    if (selectedDocs && selectedDocs.length > 0) {
      documents = await getSelectedDocuments(userId, selectedDocs);
    }

    let googleResults = "";
    if (useWebSearch) {
      // Or you could combine them with commas, or do multiple searches
      googleResults = await queryGoogleSearch(message, "statistical trends");
    }

    // Step 2: Prepare the GPT prompt to generate a pie chart
    const gptPrompt = `
      You are an expert data assistant. The user wants to generate a pie chart based on their message: "${message}". 
      
      If there is no data provided, use your expert knowledge to fill in the chart as accurately as possible.
      No matter what, generate something!
      
      Format your response as structured JSON like this:

      {
        "title": "Graph Title",
        "labels": ["Slice 1", "Slice 2", "Slice 3"],
        "values": [Value1, Value2, Value3],
        "colors": ["#FF6384", "#36A2EB", "#FFCE56"]
      }

      If the data is missing, prompt the user to provide the missing data or ask if they want to generate synthetic data.

      FORMAT YOUR RESPONSE ONLY AS VALID JSON. NO COMMENTS. NO OTHER THINGS. ONLY VALID JSON. IMPORTANT!!!

      ${
        documents.length > 0
          ? `Extract relevant data from this document to graph: ${JSON.stringify(
              documents
            )}`
          : ""
      }

      ${
        googleResults
          ? `Extract relevant data from web search results to graph:\n${googleResults}`
          : ""
      }
    `;

    // Step 3: Call GPT to generate the pie chart JSON
    const gptResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: gptPrompt },
        ],
        max_tokens: 500,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.REACT_APP_OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Step 4: Extract JSON from the response
    const responseText = gptResponse.data.choices[0]?.message?.content || "";
    //console.log(responseText);

    // Use regex to extract valid JSON from the response
    const jsonMatch = responseText.match(/{[\s\S]*}/);
    if (!jsonMatch) {
      throw new Error("No valid JSON found in GPT response");
    }

    const graphData = JSON.parse(jsonMatch[0]);
    //console.log(graphData);

    // Step 5: Return the graph data to the frontend
    res.json({
      reply: "Here is the pie chart you requested!",
      graphData,
    });
  } catch (error) {
    console.error("Error generating pie chart:", error);
    res.status(500).json({ error: "Failed to generate pie chart" });
  }
});

// In your server code, e.g. server.js or a routes file:
app.post("/clusterchart", async (req, res) => {
  const { userId, message, useWebSearch, selectedDocs } = req.body;

  if (!message) {
    return res.status(400).json({ error: "User message is required." });
  }

  try {
    let documents = [];
    // Step 1: Fetch selected documents if they exist
    if (selectedDocs && selectedDocs.length > 0) {
      documents = await getSelectedDocuments(userId, selectedDocs);
    }

    let googleResults = "";
    if (useWebSearch) {
      // Or you could combine them with commas, or do multiple searches
      googleResults = await queryGoogleSearch(message, "statistical trends");
    }

    // Step 2: Prepare GPT prompt
    const gptPrompt = `
      You are an expert data assistant. The user wants to generate a cluster (grouped) bar chart based on their message: "${message}".

      Chart instructions:
      - A cluster chart usually has multiple data series (clusters) for each label.
      - You can draw as many clusters as needed — more clusters improve insight.
      - Always use non-zero rValues.
      - rValues must align 1:1 with the values array for each cluster.
      - Avoid overlap and ensure the proximity of points reflects their relationship.
      - Cluster names should be clear and meaningful (e.g., "High-Risk Group, Low Engagement").
      - The relationships must be interpretable — avoid vagueness or meaningless labels.
      - If no data is available, return an empty array (e.g., "clusters": []).

      Format your response as valid JSON using this structure:

      {
        "title": "Your descriptive chart title",
        "xAxisLabel": "X Axis Label",
        "yAxisLabel": "Y Axis Label",
        "labels": ["Label1", "Label2", "Label3"],
        "clusters": [
          {
            "name": "Cluster 1 Name",
            "values": [10, 15, 20],
            "rValues": [5, 12, 8]
          },
          {
            "name": "Cluster 2 Name",
            "values": [30, 35, 40],
            "rValues": [20, 22, 25]
          }
        ],
        "bullets": [
          "What this chart shows",
          "What all labels for axes and clusters mean",
          "Where the data comes from (e.g. SHRM 2024, user-uploaded doc)"
        ]
      }

      YOU MUST RETURN VALID JSON NO SYNTAX ERRORS

      If the data is missing, generate a hypothetical chart.

      ${
        documents.length > 0
          ? `Extract relevant data from this document to graph: ${JSON.stringify(
              documents
            )}`
          : ""
      }

      ${
        googleResults
          ? `Extract relevant data from web search results to graph:\n${googleResults}`
          : ""
      }

      IMPORTANT: Return only valid JSON, with no code blocks or additional text.
    `;

    // Step 3: Call GPT with your settings
    const gptResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: gptPrompt },
        ],
        max_tokens: 500,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.REACT_APP_OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Step 4: Extract JSON
    const responseText = gptResponse.data.choices[0]?.message?.content || "";
    const jsonMatch = responseText.match(/{[\s\S]*}/);
    if (!jsonMatch) {
      throw new Error("No valid JSON found in GPT response");
    }

    const graphData = JSON.parse(jsonMatch[0]);
    console.log(graphData);
    console.log(JSON.stringify(graphData, null, 2));

    // Step 5: Return to front-end
    res.json({
      reply:
        graphData.bullets?.join("\n\n") ||
        "Here is the cluster chart you requested!",
      graphData,
    });
  } catch (error) {
    console.error("Error generating cluster chart:", error);
    res.status(500).json({ error: "Failed to generate cluster chart" });
  }
});

// ==============================
// NOTEPAD AI ENDPOINT
// ==============================
app.post("/notepad/ai", async (req, res) => {
  try {
    const { userId, content } = req.body;

    if (!userId || !content) {
      return res.status(400).json({ error: "Missing userId or note content." });
    }

    // Example system prompt for the AI
    const systemPrompt = `You are an AI note assistant that helps summarize meeting notes, define keywords, and add actionable top priorities.`;

    // Make request to OpenAI (or whichever LLM) for suggestions
    const openaiResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini", // or "gpt-4o-mini", etc. set your model
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `The user typed these notes:\n\n${content}\n\nPlease provide: 
            1) Three recommended next steps, to-dos or top priorities
            2) 1-3 follow up questions for the user to ask
            3) Key definitions of any jargon 
           
            Please provide your answer in plain text, no special characters.
            `,
          },
        ],
        max_tokens: 800,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.REACT_APP_OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const aiReply = openaiResponse.data.choices[0]?.message?.content || "";

    return res.json({ aiReply });
  } catch (error) {
    console.error("Error generating Notepad AI suggestions:", error);
    res.status(500).json({ error: "Failed to generate AI suggestions." });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
