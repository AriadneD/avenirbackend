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
            content: `
            You are an expert in employee benefits and data analytics. 
            Your task is to concisely summarize the uploaded document and provide a one-sentence tag.

            The summary should be written in Valid HTML markdown 
            
            

            First, determine the type of document. 
            If it is a regular document, just summarize it normally. 

            But if it is a table, focus on key quantitative trends & insights in the data.
            It should be broken down into sections.
            
            Use this type of format:
            Make an HTML table with
            Total number of value per category
            Mean, max, and min value for each column
            Category wise breakdown if there are significant differences

            After the table, provide 20 detailed, specific bullet point key findings that cover, such as:
            What is most common?
            What is most expensive/highest?
            Where do values vary the most?
            Any category level variations?
            Outliers or notable trends?

            Note: State based trends, and other social determinants of health factors are really important!! Include as many as you can.

            For the Tag:

            Provide a concise but detailed one-sentence description of the file.
            Use a precise string format, making it clear what the file contains.


            Text to analyze:\n\n${extractedText}
            
            IMPORTANT: Give your overall response in JSON format. no extra text, no "console.log json stringify", no incomplete unterminated JSON.
            {
              "summary": "<Summary here (HTML inside the JSON)>",
              "tag": "<Categorization in one sentence>"
            }`,
          },
        ],
        max_tokens: 2500,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.REACT_APP_OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    let responseText = response.data.choices[0]?.message?.content?.trim();

    console.log(responseText);

    // ✅ Remove invalid backticks (` ```json ... ``` `) if they exist
    responseText = responseText
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    // ✅ Parse the cleaned JSON response
    const { summary, tag } = JSON.parse(responseText);
    res.status(200).json({ summary, tag });
  } catch (error) {
    console.error("Error processing file:", error);
    res.status(500).json({ error: "Failed to process file" });
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
      topK: 10,
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

// NOTE: The rest of your server code (endpoints, helper functions, etc.) remains unchanged.
//       Only the /chat route is replaced with this new version below.

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
    // STEP 1: GATHER CONTEXT (USER DOCS + EXTERNAL DATA)
    // ============================================================
    const { companyName, employeeCount, locations, industry } =
      await getCompanyInfo(userId);
    const userDocuments = await getSelectedDocuments(userId, selectedDocs);
    // (A) Get user docs + build a quick chatHistory prompt if needed
    const allDocs = await getAllDocuments(userId); // returns array of {name, tag}

    let googleResults = "";
    if (useWebSearch) {
      googleResults = await queryGoogleSearch(message);
    }
    const blsData = await queryBLS();

    // Build document listing for evidence gathering
    const docListing = allDocs.map((d) => `${d.name} (${d.tag})`).join("\n");
    const shortHistory = chatHistory
      .filter((m) => m.role === "user")
      .slice(-10)
      .map((m) => `User: ${m.content}`)
      .join("\n");

    // =====================================================
    // STEP 2: CLASSIFY THE USER'S GOAL & RELEVANT DATA NEEDS
    // =====================================================
    const firstPrompt = `
      You are an expert in Employee Benefits and public health. 
      I have an extremely important task for you which needs to be in-depth, specific, and actionable. 
      You MUST read the entire prompt and follow the instructions with great precision.

      I am a head of benefits and wellbeing at my company "${companyName}" which has ${employeeCount} employees, operates in ${locations}, and operates in ${industry} industry.
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
            i) Give me background info / Understanding benefits trends / bigger picture / other data from external public data
            j) Give me company info / Understanding trends/claims costs/ other data about my internal company data
            k) Suggest actions / what can I do about this issue?
            l) industry benchmarking / what are other companies similar to me doing? 
            m) compliance question / are we compliant / understanding compliance / understanding terminology that relates to compliance / laws
            y) The question could be about either my company or public data (a-k)
            z) The question is gibberish, doesn’t make sense or it’s off topic
      3. Based on the intent of the question, List 1-3 search terms we should use to query our external database of public information. Or, if you feel that you don't need external data to answer the question, leave it blank.
      4. Based on the intent of the question, From the list of My Company Documents, List ALL of the relevant user documents that could possibly contain information relevant to the question. This is EXTREMELY important, be broad. Return their tag, which is the sentence written in parentheses () after the name. For example ${allDocs[0].tag}

      My company documents:
      ${docListing}

      Return a JSON response EXACTLY like this, no other formats:
      {
        "goalSentence": "Your single-sentence restatement of the question here.",
        "questionType": "a",
        "ragQueries": ["term1", "term2"],
        "docTags": ["tag1", "tag2"]
      }
    `.trim();

    const classificationResponse = await callOpenAI(firstPrompt, 1000);
    let parsedFirst;
    try {
      parsedFirst = JSON.parse(classificationResponse);
    } catch (error) {
      parsedFirst = {
        goalSentence: "Unknown goal.",
        questionType: "j",
        ragQueries: [],
        docTags: [],
      };
    }

    // =====================================================
    // STEP 3: GATHER RELEVANT EVIDENCE
    // =====================================================
    let ragData = [];
    for (let query of parsedFirst.ragQueries || []) {
      const matches = await performRAGQuery(query);
      ragData.push(`\n=== RAG for [${query}]:\n${matches.join("\n\n")}`);
    }

    let docSummaries = [];
    for (let tag of parsedFirst.docTags || []) {
      const docData = await getDocumentByTag(userId, tag);
      if (docData) {
        docSummaries.push(
          `DOC NAME: ${docData.name}\nSUMMARY: ${docData.summary}`
        );
      }
    }

    const compiledEvidence = `
      External/Public Data:
      ${ragData.join("\n\n")}
      
      Documents from My Company:
      ${docSummaries.join("\n\n")}
    `.trim();

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

          Generate a Request for Proposals (RFP) to get more point solutions 
          which includes the following sections: 
          (Introduction, Scope of Work, Vendor Requirements, Proposal Guidelines, Evaluation Criteria, Timeline).

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

          You can leverage these sources as needed:
          1. state/federal public health data
          2. legislation/regulatory data
          3. benefits trends
          4. bureau of labor statistics

          You could choose to include, as needed:
          Opportunities for Cost Savings & Efficiency
          Recommendations
          Next Steps & Implementation Timeline

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
          First, Directly answer the user's question in ONE SENTENCE.

          Part 1: Search the external evidence AND these sources to gather evidence, be sure to include source names.
          1. state/federal public health data
          2. legislation/regulatory data
          3. benefits trends
          4. bureau of labor statistics
          5. Industry benchmark data

          Part 2: Using your best judgement, what strategies are similar companies to me doing successfully? (anonymize the names for confidentiality)
          
          Part 3: Cross reference my company's internal medical spend trends/data with external data findings to find correlations and surprisingly nuanced insights. USE MY INTERNAL COMPANY DATA! SPECIFICALLY REFERENCE IT.

          Part 4: Hypotheses

          Focus on SPECIFIC, NUMERICAL, quantitative, statistical insights. Source information from a variety of REAL sources, especially government, corporate, and health sites (ie: NIH, SHRM, BOL... etc). DO NOT MAKE UP FACTUAL INFORMATION!


          It is important that you provide 10+ bullet points of information, and focus on the most helpful, specific, nuanced, intellectual insights. 
      `,
      j: `
      
      Respond in a structured way as follows.
      
      (optional) if the question is vague or general (ie: doesn't include location/claim type), confirm the user's goal and suggest further clarification. For example, if they asked "what benefits trends are there", say "For now, I will answer your question in general, but it would help me if you could give me a specific state or claim type, for example "NC and diabetes"".

      1. First, Directly answer the user's question in ONE SENTENCE.

      2. Next, Explain and summarize the company data that's relevant to the user's question and come up with some hypothses, for example, "what are the reasons behind these high claims?" --> SDOH factors & HRIS data

      Focus on specific, quantitative, statistical insights.

      3. Ask the user if they'd like to: (1) see the bigger picture of external data (2) get suggested actions to take

      IMPORTANT: Here are all the user's uploaded documents to analyze for steps 1 & 2:
      ${allDocs}

            `,
      k: `
      
      Respond in a structured way as follows.
      
      (optional) if the question is vague or general (ie: doesn't include location/claim type), confirm the user's goal and suggest further clarification. For example, if they asked "what can I do about my company issues", say "For now, I will answer your question in general, but it would help me if you could give me a specific state or claim type, for example "NC and diabetes"".
      
      1. First, Directly answer the user's question in ONE SENTENCE.

      2. Actionable Suggestions: give me (bullets) 5+ actionable suggestions (each should have a priority) and a quantifiable, specific, numerical breakdown of cost savings and ROI estimation with justifications. Actions could include, recommend a vendor, draft an email campaign, design a survey, etc. Get creative.

      IMPORTANT, use the sources below to construct your answer in a tailored specific way to the company's top medical spends.

            `,
      l: `

          Imagine you're the CEO of a company similarly sized, located, and industry as mine. You are giving me advice. How would you tackle this issue, what strategies would you employ, what are some case studies of success?
          At the beginning of the response, directly answer my question in 1 sentence.
          Your response should be technical, professional, objective, and in 3rd person passive.

      `,
      m: `
        First, directly answer the question in 1 concise sentence.
        Then, Provide clear, structured guidance that aligns with regulatory requirements while making the information actionable. 
        Identifying the relevant laws and regulations (e.g., ACA, HIPAA, ERISA, COBRA, or state-specific mandates) that impact their benefits program, with justifications. 
        Create a concise compliance checklist or gap analysis to help them assess whether their plans meet legal requirements. 
        If there are potential compliance risks, suggest specific actions to address them, such as updating documentation, adjusting eligibility criteria, or working with legal counsel. 
      `,
      y: `
      
            This question seems not to specify whether the question is about my company or about external context.
            Please ask the user for clarify whether they want the question to be answered for the company data or external, to start.
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
      I am a head of benefits and wellbeing at my company "${companyName}" which has ${employeeCount} employees, operates in ${locations}, and operates in ${industry} industry. 
      I have asked you this question ${message}
      Respond appropriately based on these instructions:

      ${secondPromptBody}

      Response format:
      - Provide your response in valid HTML syntax ONLY!! Only use valid tags & formatting <>.
      - Do not include the characters \
      - Use FontAwesome icons for visual structuring.
      - You can color text headings and icons with #007bff and #6a11cb.
      - Ensure tables are mobile responsive

      Evidence:
      ${compiledEvidence}
       ${googleResults ? `Google Search Results:\n${googleResults}` : ""}

      At the very end of your response, generate **exactly two follow-up questions** in the JSON format provided below. These questions must be highly detailed, relevant to the types of inquiries we can answer (Vendor selection, RFP question, Cost savings estimation, Write an email, Make a survey, Executive summary, Create a risk profile, Evaluating a point solution, Understanding benefits trends, etc.), and they must be directed at the bot, NOT the user.

      IMPORTANT: Your follow up questions **must only** contain valid JSON. Do not include any other text, explanations, or symbols.

      Return the follow-up questions using the **EXACT JSON format** below, without adding any markdown, extra characters, or explanation:
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

    const finalResponse = await callOpenAI(secondPrompt, 2500);
    let botReply = finalResponse.replace(/```html/g, "").replace(/```/g, "");
    console.log(finalResponse);
    console.log(botReply);
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

    console.log(followUps);

    // =====================================================
    // STEP 4: SUMMARIZE THE EVIDENCE (NEW STEP)
    // =====================================================
    const summaryPrompt = `
      Summarize the following content in the style of a benefits consultant in employee benefits & public health.
      Use a formal, structured, and precise tone, suitable for inclusion in a research paper.
      Include quantitative (numerical, statistical) insights as well as qualitative ones.
      Be as specific as possible.
      At the beginning of the response, explain what this evidence summary is for, in first person ("I used [sources] to provide deep research to gather evidence to answer your question").
      At the beginning of each point, use a short phrase as the "title" of that point (on the same line, separated by a colon), so it's easier to read.
      At the end, include the list of the names of the article sources in valid citation format.
      Do not return any extra commentary or conclusion.

      External/Public Data:
      ${ragData}
      
      Documents from My Company:
      ${docSummaries}

      Summarized Insights (Return in PLAIN TEXT, no bold font, bullet points only):
    `.trim();

    const summarizedResponse = await callOpenAI(summaryPrompt, 1000);
    const summarizedCompiledEvidence = summarizedResponse
      .replace(/```/g, "")
      .trim();

    return res.json({
      questionType: parsedFirst.questionType,
      reply: botReply,
      evidence: summarizedCompiledEvidence, // Include compiled evidence separately
      followUps,
    });
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
