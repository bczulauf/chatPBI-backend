import express from 'express';
import multer from 'multer';
import cors from 'cors';
import OpenAI from 'openai';
import fs from 'fs';
import EventEmitter from 'events';
import streamPythonCode from './streamCode';
import { exec } from 'child_process';

const app = express();
const port = process.env.PORT || 3001;
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors());

// Create an event emitter to manage connections and messages
const eventEmitter = new EventEmitter();

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const userToken = req.body.userToken;
    const userFolderPath = `./files/${userToken}`;
    
    if (!fs.existsSync(userFolderPath)) {
      fs.mkdirSync(userFolderPath, { recursive: true });
    }

    cb(null, userFolderPath);
  },
  filename: (_req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  },
});
const upload = multer({ storage: storage });
const userApiKeys: { [userToken: string]: string } = {};

// POST endpoint to save user's OpenAI API key
app.post('/api/setApiKey', (req, res) => {
  const userToken = req.body.userToken;
  const openaiApiKey = req.body.openaiApiKey;
  if (!userToken || !openaiApiKey) {
    return res.status(400).send('User token and OpenAI API key required');
  }

  userApiKeys[userToken] = openaiApiKey;
  res.status(200).send('API key set successfully');
});

const clients: { [key: string]: any } = {};

type TextMessage = {
  type: 'text';
  content: string;
}

type CodeMessage = {
  type: 'code';
  language: string;
  code: string;
}

type ImageMessage = {
  type: 'image';
  imageUrl: string;
  altText?: string;
}

type Message = TextMessage | CodeMessage | ImageMessage;

app.get('/events', (req, res) => {
  const userToken = req.query.userToken as string;
  console.log(userToken, 'event user token');

  if (!userToken) {
    return res.status(400).send('Token required');
  }

  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Store this client's response object
  clients[userToken] = res;

  // Event listener to send messages to the client
  const eventListener = (message: Message) => {
    const clientRes = clients[userToken]; // Rename this variable to avoid shadowing
    if (!clientRes) {
      console.error('Client response for userToken not found');
      return;
    }
    
    const jsonString = JSON.stringify(message);

    // Split by newline and format for SSE
    const formattedData = jsonString.split('\n').map(line => `data: ${line}`).join('\n');
    console.log(formattedData);

    // Send the formatted data, followed by two newline characters to signify the end of the event
    clientRes.write(`${formattedData}\n\n`);
  };

  // Register the event listener
  eventEmitter.on('message', eventListener);

  // Remove this client when they disconnect
  req.on('close', () => {
    delete clients[userToken];
  });
});

// Define the function to be used by OpenAI
const functions = [
  {
    name: "extract_dataset_info",
    description: "This function is designed to be triggered automatically whenever a user uploads a dataset. Its primary role is to provide a quick overview of the data to help both the user and the system gain insights into the dataset's structure and content.",
    parameters: {
      type: "object",
      properties: {
        file_path: { 
          type: "string",
          description: "The path to the uploaded CSV file." 
        },
        required: ["file_path"]
      }
    }
  },
  {
    name: "ask_clarification_question",
    description: "If any part of the dataset or the task is unclear, ambiguous, or incomplete, please ask for clarification.",
    parameters: {
      type: "object",
      properties: {
        user_question: { type: "string", description: "User question about the data in the CSV file."},
      },
      required: ["user_question"],
    },
  },
  {
    name: "plan",
    description: "Come up with a step by step plan to answer user data question",
    parameters: {
      type: "object",
      properties: {
        user_question: { type: "string", description: "User question about the data in the CSV file"},
        file_path: { 
          type: "string",
          description: "The path to the uploaded CSV file." 
        },
        dataset_sample: { 
          type: "string",
          description: "A representative row extracted from the dataset, obtained by executing the df.head(1) command in Python’s pandas library."
        },
      },
      required: ["user_question", "file_path", "dataset_sample"],
    },
  },
    {
      name: "write_code",
      description: "Write Python code to analyze CSV data.",
      parameters: {
        type: "object",
        properties: {
          user_question: { type: "string", description: "User question about the data in the CSV file"},
          plan: { type: "string", description: "Plan for how we can answer user question."},
          file_path: { 
            type: "string",
            description: "The path to the uploaded CSV file." 
          },
        },
        required: ["user_question", "plan", "file_path", "dataset_sample"],
      },
    },
    {
      name: "execute_code",
      description: "Execute code and return the result.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "The Python code to execute."},
        },
        required: ["code"],
      },
    },
    {
      name: "interpret_results",
      description: "Interpret results of code execution.",
      parameters: {
        type: "object",
        properties: {
          results: { 
            type: "array", 
            description: "Results of Python code execution.",
            items: {
              type: "object",
              properties: {
                data: { type: "string", description: "" },
                filePath: { type: "string", description: ""}
              }
            }
          },
        },
        required: ["results"],
      },
    },
];

const executeCode = (pythonCode: string): Promise<string> => {
  console.log(pythonCode)
  // Point to the Python interpreter in the virtual environment
  const pythonInterpreter = './myenv/bin/python';

  return new Promise((resolve, reject) => {
    exec(`${pythonInterpreter} -c "${pythonCode}"`, (error, stdout, stderr) => {
      if (error) {
        reject(`exec error: ${error}`);
        return;
      }
      if (stderr) {
        reject(stderr);
      } else {
        resolve(stdout);
      }
    });
  });
}

const extractDatasetInfo = async(filePath: string) => {
  const result = await executeCode(
`
import pandas as pd

# Path to the CSV file
file_path = '/path/to/your/file.csv'

# Read the CSV file
df = pd.read_csv(file_path)

# Print the first row
print(df.head(1))`);

return result;
}

const plan = async(openai: OpenAI, filePath: string, datasetSample: string, question: string) => {
  const codePromptMessages: OpenAI.ChatCompletionMessageParam[] = [
    {
      "role": "system",
      "content": `You are a data analyst. I want you to come up with a step by step plan for how you will answer a user data question. In order to answer the question, you can write and execute Python code that analyzes the CSV file located at '${filePath}'. Here is a sample row of data: ${datasetSample}.`
    },
    {
      "role": "user",
      "content": `User data question: ${question}.`
    }
  ];

  const planResponse = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: codePromptMessages
  });

  const plan = planResponse.choices[0].message.content;

  if (plan) {
    return plan;
  } else {
    throw new Error('Failed to generate plan from prompt');
  }
}
  
const writeCode = async (openai: OpenAI, filePath: string, datasetSample: string, question: string, plan: string): Promise<string> => {
  // First, let's ask OpenAI to generate Python code based on the data path and columns.
  const codePromptMessages: OpenAI.ChatCompletionMessageParam[] = [
    {
      "role": "system",
      "content": 
`You are a Python code generator. I want you to write code that analyzes the CSV file located at '${filePath}' based on the plan: ${plan}. Here is a sample row of data: ${datasetSample}. Inside the function:
- Always use the 'print()' function to display your results.
- If any visualizations (like plots or charts) are created, save them as a PNG in the 'tmp' folder.
- After saving the visualization, 'print()' the file path where the visualization was saved.
- Ensure all your results are displayed using 'print()' and not returned.
Now, please generate the function for me.`
    },
    {
      "role": "user",
      "content": `Analyze and answer: ${question}.`
    }
  ];

  const codeGenerationResponse = await openai.chat.completions.create({
    model: "gpt-4",
    messages: codePromptMessages
  });

  const generatedCode = codeGenerationResponse.choices[0].message.content;

  if (generatedCode) {
    return generatedCode;
  } else {
    throw new Error('Failed to generate code from prompt');
  }
};

const interpretResults = (results: {data?: string, filePath?: string}[]) => {
  for (const result of results) {
    console.log(result, 'result');
  }
}

const processMessage = async(userMessage: string, userToken: string) => {
  const openaiApiKey = userApiKeys[userToken];
    
  if (!openaiApiKey) {
    throw new Error('Invalid user token or OpenAI API key not set');
  }
  
  const openai = new OpenAI({apiKey: openaiApiKey});

  let messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: `You are the user's personal data analyst. Your role is to understand their data-related questions, craft Python code to extract the insights they're seeking, execute that code, and then explain the results in an easy-to-understand manner.`},
    { role: "user", content: userMessage }
  ];
  
  let responseMessage: any;
  let continueConversation = true;
  const MAX_ITERATIONS = 5; // Define a limit to avoid infinite loops
  let iterationCount = 0;

  while (continueConversation && iterationCount < MAX_ITERATIONS) {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: messages,
      functions: functions,
      function_call: "auto"
    });

    responseMessage = response.choices[0].message;
    messages.push(responseMessage);
    console.log(responseMessage, 'response message');

    // Emit the response to the appropriate client using SSE
    const client = clients[userToken];
    if (client) {
      client.write(`data: ${JSON.stringify(responseMessage)}\n\n`);
    }

    if (responseMessage.function_call) {
      const functionName = responseMessage.function_call.name;
      const functionArgs = JSON.parse(responseMessage.function_call.arguments);
      let functionResponse = '';

      if (functionName === 'extract_dataset_info') {
        functionResponse = await extractDatasetInfo(functionArgs.file_path);
        eventEmitter.emit('message', {type: 'text', content: functionResponse});
      }
      else if (functionName === 'plan') {
        functionResponse = await plan(openai, functionArgs.file_path, functionArgs.dataset_sample, functionArgs.user_question);
        eventEmitter.emit('message', {type: 'text', content: functionResponse});
      }
      else if (functionName === 'write_code') {
        functionResponse = await writeCode(openai, functionArgs.file_path, functionArgs.dataset_sample, functionArgs.user_question, functionArgs.plan);
        eventEmitter.emit('message', {type: 'code', code: functionResponse, language: 'python'});
      }
      else if (functionName === 'execute_code') {
        try {
          // const pythonInterpreter = './myenv/bin/python';
          functionResponse = await executeCode(functionArgs.code);
        } catch (err) {
          console.error(`Error executing code: ${err}`);
        }
      }
      else if (functionName === "interpret_results") {
        interpretResults(functionArgs.results);
      }

      messages.push({
        role: "function",
        name: functionName,
        content: functionResponse
      });

    } else {
      // If OpenAI did not make a function call and provided an answer, we'll assume the question is answered.
      // However, you may want to have a more sophisticated logic here, such as checking the content of the response.
      continueConversation = false;
    }

    iterationCount++;
  }

  return responseMessage;
}

// Endpoint to receive messages from the user
app.post('/message', upload.single('file'), async(req, res) => {
  const userMessage = req.body.message;
  const userToken = req.body.userToken;
  const file = req.file;

  if (file) {
    const filePath = file.path;
    await processMessage(`I uploaded CSV data to: ${filePath}`, userToken);
  }

  if (userMessage) {
    try {
      await processMessage(userMessage, userToken);
      res.status(200).end();
    } catch(err) {
      return res.status(400).send(err);
    }
  }
});

app.listen(port, () => {
  console.log(`Application started on port ${port}`);
});
