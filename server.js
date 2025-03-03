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

// Route to handle file summarization
app.post("/summarize", upload.single("file"), async (req, res) => {
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  let extractedText = "";

  try {
    // Process PDF files
    if (file.mimetype === "application/pdf") {
      extractedText = await pdfParse(file.buffer).then((data) => data.text);
    }
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
      const sheet = workbook.Sheets[sheetName];
      extractedText = xlsx.utils.sheet_to_csv(sheet);
    }
    // Process CSV files
    else if (file.mimetype === "text/csv") {
      extractedText = file.buffer.toString("utf-8");
    } else {
      return res.status(400).json({ error: "Unsupported file type" });
    }

    // Call GPT-4o-mini or OpenAI API to summarize the text
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          {
            role: "user",
            content: `You are an expert in employee benefits and data analytics. Your task is to summarize this uploaded document:

            - If it is a table, preserve all columns and, for quantitative values, state the average, max, and min values for each column. If the value is monthly/yearly/seasonaly, state how the change progressed over that period of time, including the min month, max month, average month. If the value varies by a qualitative value, ie by gender or by state, preserve those columns individually with the min, max, avg. For qualitative values, give the percentages of each value. 
            - If it is a document, summarize as usual, focusing on key insights

            IMPORTANT: Provide your answer in valid HTML markdown syntax!!!
            Text to summarize:\n\n${extractedText}`,
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

    let summary = response.data.choices[0]?.message?.content?.trim();

    // Step 6: Remove the literal "```html" and "```" from the response
    summary = summary.replace(/```html/g, "").replace(/```/g, "");

    res.status(200).json({ summary });
  } catch (error) {
    console.error("Error processing file:", error);
    res.status(500).json({ error: "Failed to process file" });
  }
});

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

// Helper function to query Google Custom Search API
const queryGoogleSearch = async (query) => {
  const response = await axios.get(
    `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(
      query
    )}&key=${GOOGLE_API_KEY}&cx=${SEARCH_ENGINE_ID}`
  );

  return response.data.items
    ? response.data.items
        .map((item) => `${item.title}: ${item.snippet}`)
        .join("\n")
    : "No relevant results found.";
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
      topK: 5,
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

// POST /chat route
app.post("/chat", async (req, res) => {
  try {
    // ---------------------------
    // STEP 0: EXTRACT USER INPUTS
    // ---------------------------
    const { userId, message, chatHistory, useWebSearch, selectedDocs } =
      req.body;
    if (!message) {
      return res.status(400).json({ error: "User message is required." });
    }

    // ============================================================
    // STEP 1: GATHER CONTEXT (NOT RAG)
    // ============================================================
    const { companyName, employeeCount, locations } = await getCompanyInfo(
      userId
    );
    const userDocuments = await getSelectedDocuments(userId, selectedDocs);

    //idk if this will work
    const allDocs = await getUserUploadedDocuments(userId);

    let googleResults = "";
    if (useWebSearch) {
      googleResults = await queryGoogleSearch(message);
    }

    const blsData = await queryBLS();

    // ======================================================
    // STEP 2: BUILD CHAT HISTORY
    // ======================================================
    const maxTokens = 3000; // or whichever limit
    let chatHistoryTokens = 0;

    const historyPrompt = chatHistory
      .reverse()
      .map((msg) => {
        const tokenEstimate = msg.content.length / 4; // approximate token estimate
        if (chatHistoryTokens + tokenEstimate < maxTokens) {
          chatHistoryTokens += tokenEstimate;
          return `${msg.role === "user" ? "User" : "Assistant"}: ${
            msg.content
          }`;
        }
        return null;
      })
      .filter(Boolean)
      .reverse()
      .join("\n");

    // Construct user only history (for first prompt)
    const promptHistory = chatHistory
      .reverse() // Start from the most recent message
      .filter((msg) => msg.role === "user") // Keep only user messages
      .map((msg) => {
        const tokenEstimate = msg.content.length / 4; // Approximate token estimate
        if (chatHistoryTokens + tokenEstimate < maxTokens) {
          chatHistoryTokens += tokenEstimate;
          return `User: ${msg.content}`; // Format user messages
        }
        return null; // Skip messages if over token limit
      })
      .filter(Boolean) // Remove skipped messages (null values)
      .reverse() // Restore original order
      .join("\n"); // Join messages into a single formatted string

    // ======================================================
    // STEP 3: FIGURE OUT THE USER'S GOAL (CLASSIFY QUESTION)
    // ======================================================
    const firstPrompt = `
You are an expert in Employee Benefits and public health. 
I have an extremely important task for you which needs to be in-depth, specific and actionable. 
You MUST read the entire prompt and follow the instructions with great precision.

I am a head of benefits and wellbeing at my company "${companyName}" which has ${employeeCount} employees and operates in ${locations}.
I have asked you this question: "${message}".

First, determine what type of question is being asked to find out the best way to respond. 

Here are the possible question types (select exactly ONE):
a) Vendor question
b) RFP question
c) Cost savings estimation
d) Write an email
e) Make a survey
f) Executive summary
g) Create a risk profile
h) Evaluating a point solution
i) Give me background info / Understanding benefits trends / bigger picture / other data from external public data
j) Give me company info / Understanding trends/claims costs/ other data about my internal company data
k) Suggest actions / what can I do about this issue?
y) The question could be about either my company or public data (a-k)
z) The question doesn’t make sense or it’s off topic

ONLY RETURN ONE LETTER (a-j, k, or z) with no other text or explanation.
    `.trim();

    const classificationResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: firstPrompt },
        ],
        max_tokens: 50,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.REACT_APP_OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    let questionType =
      classificationResponse.data.choices[0]?.message?.content.trim() || "j";

    questionType = questionType.toLowerCase().replace(/[^a-jk]/g, "") || "j";
    console.log("Question Type:", questionType);

    // =====================================================================================
    // STEP 4: READ USER-UPLOADED DOC SUMMARIES, DETERMINE RELEVANT DOCS, GET INSIGHTS,
    //         AND COME UP WITH A PROMPT TO ASK RAG FOR "FURTHER RESEARCH"
    // -------------------------------------------------------------------------------------
    //   => We'll do a short GPT call that processes userDocuments, googleResults, BLS data,
    //      and the user’s question to create a “ragPrompt” that we'll feed to Pinecone in Step 5.
    // =====================================================================================

    // If you want to keep it super simple, you could do something like:
    const buildRAGPrompt = `
      You are an expert in employee benefits.
      We have these user-uploaded document summaries:\n${JSON.stringify(
        userDocuments
      )}
      We also have some optional external data from google or BLS:\nGoogle:\n${googleResults}\nBLS:\n${blsData}

      The user asked: "${message}". 

      Please figure out the most relevant, SPECIFIC query to ask our vector database (RAG) so that we can get more context.
      Please return ONLY that single query, with no extra text or explanation. 
    `;

    const ragPromptResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: buildRAGPrompt },
        ],
        max_tokens: 100,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.REACT_APP_OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    let ragPrompt =
      ragPromptResponse.data.choices[0]?.message?.content.trim() ||
      "benefits claims cost trends";
    console.log("RAG Prompt:", ragPrompt);

    // =====================================================
    // STEP 5: QUERY RAG WITH THE *MOST RELEVANT PROMPT*
    //          (NOT THE USER'S ORIGINAL MESSAGE)
    // -----------------------------------------------------
    //    => Now we do our original Pinecone call:
    // =====================================================
    const ragResults = await performRAGQuery(ragPrompt);

    // =====================================================
    // STEP 6: READ THE RAG RESULTS & GET INSIGHTS
    // -----------------------------------------------------
    //    => We'll just store them in a variable for now:
    // =====================================================
    const ragInsights = ragResults.join("\n\n");
    //console.log("RAG Insights:", ragInsights);

    // =====================================================
    // STEP 7: COMBINE USER DOC INSIGHTS WITH RAG INSIGHTS
    // -----------------------------------------------------
    //    => We'll produce one consolidated string, for the final GPT call
    // =====================================================
    const finalCombinedData = `
    User Document Insights:
    ${userDocuments.join("\n\n")}

    RAG Insights:
    ${ragInsights}

    Google Results (optional):
    ${googleResults}

    BLS Data:
    ${blsData}
    `.trim();

    // =====================================================
    // STEP 8: ANSWER THE USER'S QUESTION, CONTEXTUALIZED
    // -----------------------------------------------------
    //    => Re-use your “secondPrompts” approach, but
    //       feed finalCombinedData as the "public data".
    // =====================================================

    const secondPrompts = {
      a: `
You are an expert in Employee Benefits and public health. 
I have an extremely important task for you which needs to be in-depth, specific and actionable. 
You MUST read the entire prompt and follow the instructions with great precision. 
I am a head of benefits and wellbeing at my company "${companyName}" which has ${employeeCount} employees and operates in ${locations}, 
and I have asked you this question: "${message}”.

Use the public/web data (attached below) to suggest 3 point solution vendors to target the issues stated above 
IMPORTANT!!! ONLY SUGGEST REAL vendors that are REAL businesses. Do not make up factual information, do not hallucinate. 
Give extremely specific expert vendors tailored to the circumstance.). 
In a table, evaluate the vendors by name (with a clickable href URL to their website), features, cost, engagement, NPS, user feedback, integration.

      `,
      b: `
You are an expert in Employee Benefits and public health. 
I have an extremely important task for you which needs to be in-depth, specific and actionable. 
You MUST read the entire prompt and follow the instructions with great precision. 
I am a head of benefits and wellbeing at my company "${companyName}" which has ${employeeCount} employees and operates in ${locations}, 
and I have asked you this question: "${message}”.

Generate a Request for Proposals (RFP) to get more point solutions 
which includes the following sections: 
(Introduction, Scope of Work, Vendor Requirements, Proposal Guidelines, Evaluation Criteria, Timeline).

      `,
      c: `
You are an expert in Employee Benefits and public health. 
I have an extremely important task for you which needs to be in-depth, specific and actionable. 
You MUST read the entire prompt and follow the instructions with great precision. 
I am a head of benefits and wellbeing at my company "${companyName}" which has ${employeeCount} employees and operates in ${locations}, 
and I have asked you this question: "${message}”.

Use scientific, mathematical, and financial equations to state the quantifiable, specific, 
numerical breakdown of cost savings and ROI estimation with justifications that reflects the situation above.

      `,
      d: `
You are an expert in Employee Benefits and public health. 
I have an extremely important task for you which needs to be in-depth, specific and actionable. 
You MUST read the entire prompt and follow the instructions with great precision. 
I am a head of benefits and wellbeing at my company "${companyName}" which has ${employeeCount} employees and operates in ${locations}, 
and I have asked you this question: "${message}”.

Write a highly personalized email that’s professional and concise which responds to the situation above.

      `,
      e: `
You are an expert in Employee Benefits and public health. 
I have an extremely important task for you which needs to be in-depth, specific and actionable. 
You MUST read the entire prompt and follow the instructions with great precision. 
I am a head of benefits and wellbeing at my company "${companyName}" which has ${employeeCount} employees and operates in ${locations}, 
and I have asked you this question: "${message}”.

Generate a valid HTML survey which addresses the situation above 
(valid in the sense that checkboxes should be clickable, input forms should be real text input, etc.).

      `,
      f: `
You are an expert in Employee Benefits and public health. 
I have an extremely important task for you which needs to be in-depth, specific and actionable. 
You MUST read the entire prompt and follow the instructions with great precision. 
I am a head of benefits and wellbeing at my company "${companyName}" which has ${employeeCount} employees and operates in ${locations}, 
and I have asked you this question: "${message}”.

Generate a detailed executive summary for my manager that reflects the situation above.
Company Overview – Provides a brief summary of the organization's size, industry, workforce demographics, and key business objectives related to employee benefits.
Current Benefits Landscape – Outlines the structure of existing benefits programs, including health plans, wellness initiatives, and voluntary benefits.
Key Findings & Insights – Summarizes major trends, challenges, and opportunities identified from benefits data and employee feedback.
Claims Cost Analysis – Breaks down healthcare claims data to highlight cost drivers, high-risk areas, and emerging expense trends.
Employee Engagement & Utilization Trends – Examines participation rates, program adoption, and employee satisfaction with benefits offerings.
Compliance & Regulatory Considerations – Identifies potential compliance risks, upcoming regulatory changes, and legal obligations affecting benefits programs.
Benchmarking Against Industry Standards – Compares the company’s benefits offerings, costs, and engagement metrics against competitors and industry benchmarks.
Opportunities for Cost Savings & Efficiency – Highlights specific areas where costs can be reduced through plan adjustments, vendor optimizations, or targeted interventions.
Recommendations & Strategic Action Plan – Provides actionable strategies to enhance benefits effectiveness, control costs, and improve employee well-being.
Next Steps & Implementation Timeline – Defines the key actions, responsible stakeholders, and projected timeline for executing benefits improvements.

      `,
      g: `
You are an expert in Employee Benefits and public health. 
I have an extremely important task for you which needs to be in-depth, specific and actionable. 
You MUST read the entire prompt and follow the instructions with great precision. 
I am a head of benefits and wellbeing at my company "${companyName}" which has ${employeeCount} employees and operates in ${locations}, 
and I have asked you this question: "${message}”.

Come up with a Risk profile workflow based on the provided company size (${employeeCount} employees) 
and areas of operation (${locations}) that is able to predict and forecast clinical risk. 

Come up with a Risk profile workflow based on the provided company size (${employeeCount} employees) and areas of operation (${locations}) that is able to predict and forecast clinical risk which ONLY includes sections on these following parts: (1) Persona analysis - segment employees into different named groups based on age, tenure, generation (different groups have different needs) and state the percentage of employees belonging to each group (2) SDOH - Segment employees further based on their states/geographic areas, and specifically identify the SPECIFIC risks for each state in the Deprivation index: Income, Employment, Education, Housing, Health, Access to Services, Crime (3) Perform a Clinical risk forecast for each group (4) Suggested Benefits targeting - recommend specific benefits within that population (5) KPIs - identify which success metrics we can use to monitor 

`,
      h: `
You are an expert in Employee Benefits and public health. 
I have an extremely important task for you which needs to be in-depth, specific and actionable. 
You MUST read the entire prompt and follow the instructions with great precision. 
I am a head of benefits and wellbeing at my company "${companyName}" which has ${employeeCount} employees and operates in ${locations}, 
and I have asked you this question: "${message}”.

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
You are an expert in Employee Benefits and public health. I have an extremely important task for you which needs to be in-depth, specific and actionable. You MUST read the entire prompt and follow the instructions with great precision. I am a head of benefits and wellbeing at my company "${companyName}" which has ${employeeCount} employees and operates in ${locations}, and I have asked you this question: "${message}”.

Respond in a structured way as follows. IMPORTANT: INCLUDE ALL SECTIONS LISTED BELOW

Public Trends: Tell me what is going on from the perspective of public data. 
1. state/federal public health data
2. legislation/regulatory data
3. benefits trends
4. bureau of labor statistics
5. Cross reference company internal medical spend trends/data with external data to find correlations and surprisingly nuanced insights
6. Ask the user if theyd like to know what actions they can take

Focus on SPECIFIC, NUMERICAL, quantitative, statistical insights. Source information from a variety of REAL sources, especially government, corporate, and health sites (ie: NIH, SHRM, BOL... etc). DO NOT MAKE UP FACTUAL INFORMATION!

It is important that you provide 10+ bullet points of information, and focus on the most helpful, specific, nuanced, intellectual insights. 
      `,
      j: `
      You are an expert in Employee Benefits and public health. I have an extremely important task for you which needs to be in-depth, specific and actionable. You MUST read the entire prompt and follow the instructions with great precision. I am a head of benefits and wellbeing at my company "${companyName}" which has ${employeeCount} employees and operates in ${locations}, and I have asked you this question: "${message}”.
      
      Respond in a structured way as follows.
      
      1. (optional) if the question is vague or general (ie: doesn't include location/claim type), confirm the user's goal and suggest further clarification. For example, if they asked "what benefits trends are there", say "For now, I will answer your question in general, but it would help me if you could give me a specific state or claim type, for example "NC and diabetes"".

      1. Directly answer the user's question in bullet points from reading and analyzing the user's company data (userDocuments).
      For example "what is the highest claim?" --> "Cancer". 
      2. Explain and summarize the company data that's relevant to the user's question and come up with some hypothses, for example, "what are the reasons behind these high claims?" --> SDOH factors & HRIS data

      Focus on specific, quantitative, statistical insights.

      3. Ask the user if they'd like to: (1) see the bigger picture of external data (2) get suggested actions to take

      IMPORTANT: Here are all the user's uploaded documents to analyze for steps 1 & 2:
      ${allDocs}

            `,
      k: `
      You are an expert in Employee Benefits and public health. I have an extremely important task for you which needs to be in-depth, specific and actionable. You MUST read the entire prompt and follow the instructions with great precision. I am a head of benefits and wellbeing at my company "${companyName}" which has ${employeeCount} employees and operates in ${locations}, and I have asked you this question: "${message}”.
      
      Respond in a structured way as follows.
      
      1. (optional) if the question is vague or general (ie: doesn't include location/claim type), confirm the user's goal and suggest further clarification. For example, if they asked "what can I do about my company issues", say "For now, I will answer your question in general, but it would help me if you could give me a specific state or claim type, for example "NC and diabetes"".

      2. Actionable Suggestions: give me (bullets) 5+ actionable suggestions (each should have a priority) and a quantifiable, specific, numerical breakdown of cost savings and ROI estimation with justifications. Actions could include, recommend a vendor, draft an email campaign, design a survey, etc. Get creative.

      IMPORTANT, use the sources below to construct your answer in a tailored specific way to the company's top medical spends.

            `,
      y: `
            You are an expert in Employee Benefits and public health. 
            I have an extremely important task for you which needs to be in-depth, specific and actionable. 
            You MUST read the entire prompt and follow the instructions with great precision. 
            I am a head of benefits and wellbeing at my company "${companyName}" which has ${employeeCount} employees and operates in ${locations}, 
            and I have asked you this question: "${message}”.
      
            This question seems not to specify whether the question is about my company or about external context.
            Please ask the user for clarify whether they want the question to be answered for the company data or external, to start.
            `,
      z: `
      You are an expert in Employee Benefits and public health. 
      I have an extremely important task for you which needs to be in-depth, specific and actionable. 
      You MUST read the entire prompt and follow the instructions with great precision. 
      I am a head of benefits and wellbeing at my company "${companyName}" which has ${employeeCount} employees and operates in ${locations}, 
      and I have asked you this question: "${message}”.

      This question doesn’t make sense or is off topic. 
      Please ask the user for clarification.
      `,
    };

    // If the type is missing, default to "j":
    let secondPromptBody = secondPrompts[questionType] || secondPrompts["j"];

    // Add your universal instructions at the end
    const secondPromptFooter = `

    ${googleResults ? `Google Search Results:\n${googleResults}` : ""}
    Public/External Data + Internal Insights:
    ${finalCombinedData}

    IMPORTANT! DO NOT MAKE UP FACTUAL INFORMATION! ONLY PROVIDE REAL SOURCES FROM ACTUAL WEBSITES WITH ACCURATE VALID INFORMATION.
    IMPORTANT! For the response body (not the follow up questions) Provide your answer in valid HTML Markdown syntax only, no asterisks no ***!! Only use valid <HTML> tags
    IMPORTANT! Incorporate FontAwesome icons to structure your response in a nicely visually appealing way.
    IMPORTANT! Make your response aesthetically appealing by adding colored text, highlights, etc.
    IMPORTANT! Do not produce extra commentary beyond the instructions. No weird HTML explanations or CTAs after the answer!!!!!!

    Here’s what we’ve said in previous conversations, for context:
${historyPrompt}
    `.trim();

    // Build Final Prompt (Same as before)
    const finalSecondPrompt = `
      ${secondPromptBody}
      ${secondPromptFooter}

      IMPORTANT: At the very end of your response, generate **exactly two follow-up questions** that the user can ask next. These questions should be:
      - Relevant to the conversation.
      - Thought-provoking.
      - Helpful for deeper insights.
      - Relevant to question types we can answer (for example: Vendor selection, RFP question, Cost savings estimation, Write an email, Make a survey, Executive summary, Create a risk profile, Evaluating a point solution, Give me background info / Understanding benefits trends / bigger picture / other data from external public data, Give me company info / Understanding trends/claims costs/ other data about my internal company data, Suggest actions / what can I do about this issue?)

      IMPORTANT 
      **Return follow up questions in this structured JSON format at the bottom of your response:**
      \`\`\`json
      { "followUps": ["Follow-up question 1?", "Follow-up question 2?"] }
      \`\`\`
    `.trim();

    // Make the final GPT call
    const openaiResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: finalSecondPrompt },
        ],
        max_tokens: 5000,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.REACT_APP_OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    let botReply =
      openaiResponse.data.choices[0]?.message?.content ||
      "I'm sorry, I couldn't process that.";

    botReply = botReply.replace(/```html/g, "").replace(/```/g, "");

    // Extract follow-up questions from JSON response
    const followUpMatch = botReply.match(/json\s*(\{[\s\S]*?\})/);
    let followUps = [];
    if (followUpMatch) {
      try {
        const jsonPart = followUpMatch[1].trim();
        followUps = JSON.parse(jsonPart).followUps || [];
        // Remove the matched JSON string from botReply
        botReply = botReply.replace(followUpMatch[0], "").trim();
      } catch (err) {
        console.error("Error parsing follow-ups:", err);
      }
    }
    console.log(followUps);
    return res.json({ questionType, reply: botReply, followUps });
  } catch (error) {
    console.error("Error handling chat request:", error);
    return res.status(500).json({ error: "Failed to process chat request." });
  }
});

app.post("/bargraph", async (req, res) => {
  const { userId, message, selectedDocs } = req.body;

  if (!message) {
    return res.status(400).json({ error: "User message is required." });
  }

  try {
    let documents = [];

    // Step 1: Fetch selected documents only if they exist
    if (selectedDocs && selectedDocs.length > 0) {
      documents = await getSelectedDocuments(userId, selectedDocs);
    }

    // Step 2: Prepare the GPT prompt to generate a bar graph
    const gptPrompt = `
      You are an expert data assistant. The user wants to generate a bar graph based on their message: "${message}". 
      
      If there is no data provided, use your expert knowledge to fill in the graph as accurately as possible.
      No matter what, generate something!
      
      Format your response as structured JSON like this:

      {
        "title": "Graph Title",
        "labels": ["Label1", "Label2"],
        "values": [Value1, Value2]
      }

      If the data is missing, prompt the user to provide the missing data or ask if they want to generate synthetic data.
      
      FORMAT YOUR RESPONSE ONLY AS VALID JSON. NO COMMENTS. NO OTHER THINGS. ONLY VALID JSON. IMPORTANT!!!
      
      ${
        documents.length > 0
          ? `Extract relevant data from these documents to graph: ${JSON.stringify(
              documents
            )}`
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
      reply: "Here is the bar graph you requested!",
      graphData,
    });
  } catch (error) {
    console.error("Error generating bar graph:", error);
    res.status(500).json({ error: "Failed to generate bar graph" });
  }
});

app.post("/linegraph", async (req, res) => {
  const { userId, message, selectedDocs } = req.body;

  if (!message) {
    return res.status(400).json({ error: "User message is required." });
  }

  try {
    let documents = [];

    // Step 1: Fetch selected documents only if they exist
    if (selectedDocs && selectedDocs.length > 0) {
      documents = await getSelectedDocuments(userId, selectedDocs);
    }

    // Step 2: Prepare the GPT prompt to generate a line graph
    const gptPrompt = `
      You are an expert data assistant. The user wants to generate a line graph based on their message: "${message}". 
      
      If there is no data provided, use your expert knowledge to fill in the graph as accurately as possible.
      No matter what, generate something!
      
      Format your response as structured JSON like this:

      {
        "title": "Graph Title",
        "labels": ["Label1", "Label2", "Label3"],
        "datasets": [
          {
            "label": "Dataset 1",
            "data": [Value1, Value2, Value3],
            "borderColor": "rgb(75, 192, 192)",
            "backgroundColor": "rgba(75, 192, 192, 0.2)"
          },
          {
            "label": "Dataset 2",
            "data": [Value4, Value5, Value6],
            "borderColor": "rgb(255, 99, 132)",
            "backgroundColor": "rgba(255, 99, 132, 0.2)"
          }
        ]
      }

      If the data is missing, prompt the user to provide the missing data or ask if they want to generate synthetic data.

      FORMAT YOUR RESPONSE ONLY AS VALID JSON. NO COMMENTS. NO OTHER THINGS. ONLY VALID JSON. IMPORTANT!!!
      
      ${
        documents.length > 0
          ? `Extract relevant data from these documents to graph: ${JSON.stringify(
              documents
            )}`
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
      reply: "Here is the line graph you requested!",
      graphData,
    });
  } catch (error) {
    console.error("Error generating line graph:", error);
    res.status(500).json({ error: "Failed to generate line graph" });
  }
});

app.post("/piechart", async (req, res) => {
  const { userId, message, selectedDocs } = req.body;

  if (!message) {
    return res.status(400).json({ error: "User message is required." });
  }

  try {
    let documents = [];

    // Step 1: Fetch selected documents only if they exist
    if (selectedDocs && selectedDocs.length > 0) {
      documents = await getSelectedDocuments(userId, selectedDocs);
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
          ? `Extract relevant data from these documents to graph: ${JSON.stringify(
              documents
            )}`
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

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
