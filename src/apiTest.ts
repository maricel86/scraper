import { promises as fsPromises } from 'fs';
import { parse } from 'csv-parse/sync';
import got from 'got';

const API_INPUT_FILE = 'API-input-sample.csv';
const API_OUTPUT_FILE = 'API-test-output.json';
const API_ENDPOINT = 'http://localhost:3000/match';

interface TestInput {
  "input name": string;
  "input phone": string;
  "input website": string;
  "input_facebook": string;
}

async function runTest() {
  try {
    // Read and parse the input CSV
    const rawCsv = await fsPromises.readFile(API_INPUT_FILE, 'utf-8');
    const records: TestInput[] = parse(rawCsv, {
      columns: true,
      skip_empty_lines: true
    });
    
    const results: any[] = [];
    
    // For each row, send a request to the API
    for (const record of records) {
      const payload = {
        input_name: record["input name"]?.trim() || "",
        input_phone: record["input phone"]?.trim() || "",
        input_website: record["input website"]?.trim() || "",
        input_facebook: record["input_facebook"]?.trim() || ""
      };

      try {
        const response = await got.post(API_ENDPOINT, {
          json: payload,
          headers: { 'Content-Type': 'application/json' },
          responseType: 'json'
        });
        
        const matchFound = response.statusCode === 200;
        const matchIndicator = matchFound ? '✅ FOUND' : '❌ NOT FOUND';
        const searchCriteria = Object.entries(payload)
          .filter(([_, value]) => value !== '')
          .map(([key, value]) => `${key.replace('input_', '')}: ${value}`)
          .join(', ');
        
        console.log(`${matchIndicator} - ${searchCriteria}`);
        
        results.push({
          input: payload,
          output: response.body,
          status: "success",
          matchFound
        });
      } catch (error: any) {
        const errorMessage = error.response ? error.response.body?.error || 'API error' : error.message;
        console.log(`❌ ERROR - ${errorMessage}`);
        
        results.push({
          input: payload,
          output: error.response ? error.response.body : error.message,
          status: "error",
          matchFound: false
        });
      }
    }
    
    // Write the results to an output file
    await fsPromises.writeFile(API_OUTPUT_FILE, JSON.stringify(results, null, 2), 'utf8');
    console.log(`Test completed. Results written to ${API_OUTPUT_FILE}`);
  } catch (err) {
    console.error("Error in test script:", err);
  }
}

runTest();
