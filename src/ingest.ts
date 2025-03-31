import { promises as fsPromises } from 'fs';
import { Client } from '@elastic/elasticsearch';
import dotenv from 'dotenv';
import { performance } from 'perf_hooks';
import { parse } from 'csv-parse/sync';
import { ExtractedData } from './types';

// Load environment variables
dotenv.config();

// Get Elasticsearch configuration from environment variables
const ES_NODE = process.env.ELASTICSEARCH_NODE || 'http://localhost:9200';
const ES_INDEX = process.env.ELASTICSEARCH_INDEX || 'websites_data';
const ES_USERNAME = process.env.ELASTICSEARCH_USERNAME;
const ES_PASSWORD = process.env.ELASTICSEARCH_PASSWORD;
const ES_API_KEY = process.env.ELASTICSEARCH_API_KEY;

// File paths
const ALL_RESULTS_FILE = 'all_results.json';
const CSV_FILE = 'sample-websites-company-names.csv';

/**
 * Normalize a phone number by removing all non-digit characters.
 */
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

/**
 * Main function to handle the ingest process
 */
async function ingest(): Promise<void> {
  const startTime = performance.now();
  console.log(`Starting ingest process to Elasticsearch: ${ES_NODE}`);
  console.log(`Using index: ${ES_INDEX}`);

  try {
    // Read and parse the JSON file (extracted data)
    const rawJsonData = await fsPromises.readFile(ALL_RESULTS_FILE, 'utf-8');
    const jsonData: Record<string, ExtractedData> = JSON.parse(rawJsonData);
    
    // Read and parse the CSV file (company names data)
    const rawCsvData = await fsPromises.readFile(CSV_FILE, 'utf-8');
    const csvRecords = parse(rawCsvData, {
      columns: true,
      skip_empty_lines: true
    });

    // Merge data pe baza domeniului (normalizăm domeniul la lowercase)
    const mergedRecords = csvRecords.map((record: any) => {
      const domain = record.domain.trim().toLowerCase();
      // Dacă nu se găsește în JSON, folosim valorile implicite
      const extracted: ExtractedData = jsonData[domain] || {
        phone_numbers: [],
        social_media_links: [],
        addresses: []
      };

      return {
        domain,
        company_commercial_name: record.company_commercial_name || null,
        company_legal_name: record.company_legal_name || null,
        company_all_available_names: record.company_all_available_names || null,
        // Normalizează toate numerele de telefon
        phone_numbers: (extracted.phone_numbers || []).map(normalizePhone),
        social_media_links: extracted.social_media_links || [],
        addresses: extracted.addresses || [],
        timestamp: new Date().toISOString()
      };
    });

    console.log(`Found ${mergedRecords.length} merged records to ingest`);

    // Initialize Elasticsearch client
    const client = createElasticsearchClient();
    
    // Check if the index exists, delete it if it does
    if (await client.indices.exists({ index: ES_INDEX })) {
      await client.indices.delete({ index: ES_INDEX });
      console.log(`Index ${ES_INDEX} deleted.`);
    }
    // Create a new index
    await createIndex(client, ES_INDEX);

    // Ingest merged data into Elasticsearch
    const ingestResult = await ingestData(client, mergedRecords, ES_INDEX);
    
    const endTime = performance.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    
    console.log(`\n=== INGEST SUMMARY ===`);
    console.log(`Total records processed: ${mergedRecords.length}`);
    console.log(`Successfully ingested: ${ingestResult.success}`);
    console.log(`Failed to ingest: ${ingestResult.failed}`);
    console.log(`Duration: ${duration} seconds`);
    console.log(`======================\n`);
    
    if (ingestResult.failed > 0) {
      console.log(`Failed records:`);
      ingestResult.failedSites.forEach(site => {
        console.log(`- ${site.site}: ${site.error}`);
      });
    }
  } catch (error) {
    console.error(`Error during ingest process: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

/**
 * Create Elasticsearch client with authentication
 */
function createElasticsearchClient(): Client {
  const clientConfig: any = {
    node: ES_NODE
  };

  // Add authentication if provided
  if (ES_API_KEY) {
    clientConfig.auth = { apiKey: ES_API_KEY };
  } else if (ES_USERNAME && ES_PASSWORD) {
    clientConfig.auth = {
      username: ES_USERNAME,
      password: ES_PASSWORD
    };
  }

  return new Client(clientConfig);
}

/**
 * Check if an index exists
 */
async function checkIndexExists(client: Client, indexName: string): Promise<boolean> {
  try {
    const exists = await client.indices.exists({ index: indexName });
    return exists;
  } catch (error) {
    console.log(`Index ${indexName} does not exist. Will be created.`);
    return false;
  }
}

/**
 * Create an index with mapping
 */
async function createIndex(client: Client, indexName: string): Promise<void> {
  try {
    console.log(`Creating index: ${indexName}...`);
    
    await client.indices.create({
      index: indexName,
      mappings: {
        properties: {
          domain: { type: 'keyword' },
          company_commercial_name: { type: 'text' },
          company_legal_name: { type: 'text' },
          company_all_available_names: { type: 'text' },
          phone_numbers: { type: 'keyword' },
          social_media_links: { type: 'keyword' },
          addresses: { type: 'text' },
          timestamp: { type: 'date' }
        }
      }
    });
    
    console.log(`Index ${indexName} created successfully`);
  } catch (error) {
    console.error(`Error creating index: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

// Interface for failed record information
interface FailedSite {
  site: string;
  error: string;
}

// Interface for ingest result
interface IngestResult {
  success: number;
  failed: number;
  failedSites: FailedSite[];
}

/**
 * Ingest merged data into Elasticsearch
 */
async function ingestData(
  client: Client, 
  records: any[], 
  indexName: string
): Promise<IngestResult> {
  let success = 0;
  let failed = 0;
  const failedSites: FailedSite[] = [];
  
  // Process in batches for better performance
  const batchSize = 50;
  const totalRecords = records.length;
  
  console.log(`Starting batch ingest process for ${totalRecords} records...`);
  
  for (let i = 0; i < totalRecords; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const bulkOperations: any[] = [];
    
    // Prepare bulk operations (folosim domeniul ca _id pentru overwrite)
    batch.forEach(record => {
      bulkOperations.push({ index: { _index: indexName, _id: record.domain } });
      bulkOperations.push(record);
    });
    
    if (bulkOperations.length === 0) continue;
    
    try {
      // Execute bulk operation
      const response = await client.bulk({ 
        refresh: true,
        operations: bulkOperations 
      });
      
      if (response.errors) {
        response.items.forEach((item: any, idx: number) => {
          if (item.index && item.index.error) {
            const recordIndex = Math.floor(idx / 2);
            let siteName = 'unknown';
            if (recordIndex >= 0 && recordIndex < batch.length) {
              siteName = batch[recordIndex].domain;
            }
            failed++;
            const errorType = item.index.error?.type || 'Unknown error';
            const errorReason = item.index.error?.reason || 'No reason provided';
            failedSites.push({
              site: siteName,
              error: `${errorType}: ${errorReason}`
            });
          } else {
            success++;
          }
        });
      } else {
        success += batch.length;
      }
      
      console.log(`Processed batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(totalRecords / batchSize)}: ${batch.length} records`);
    } catch (error) {
      console.error(`Error in bulk operation: ${error instanceof Error ? error.message : String(error)}`);
      failed += batch.length;
      batch.forEach(record => {
        failedSites.push({
          site: record.domain,
          error: `Bulk operation failed: ${error instanceof Error ? error.message : String(error)}`
        });
      });
    }
  }
  
  return { success, failed, failedSites };
}

// Run the ingest process
ingest().catch(error => {
  console.error(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});