import { promises as fsPromises } from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { readInputCsv } from './inputLoader';
import { SiteProcessor, SiteProcessorConfig } from './siteProcessor';
import { StatusReporter } from './statusReporter';
import { ExtractedData } from './types';
import dotenv from 'dotenv';
dotenv.config();

// File operation queue to prevent concurrent JSON file updates
class FileOperationQueue {
  private queue: Array<() => Promise<void>> = [];
  private running = false;
  
  public async enqueue(operation: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          await operation();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      
      if (!this.running) {
        this.processQueue();
      }
    });
  }
  
  private async processQueue() {
    if (this.running) return;
    
    this.running = true;
    
    while (this.queue.length > 0) {
      const operation = this.queue.shift();
      if (operation) {
        try {
          await operation();
        } catch (error) {
          console.error("Error in queued file operation:", error);
        }
      }
    }
    
    this.running = false;
  }
}

// Create a singleton instance of the queue
const fileOperationQueue = new FileOperationQueue();


// --- Configuration ---
const INPUT_FILE = 'input.csv';
const OUTPUT_DIR = 'download';
const OUTPUT_JSON_DIR = path.join(OUTPUT_DIR, 'json_results');

/**
 * Process sites using a worker queue for maximum efficiency
 * @param sites List of site URLs to process
 * @param processor The site processor instance
 * @param logErrorFn Function to log errors
 * @param concurrencyLimit Maximum number of concurrent processes (default: 10)
 * @returns Object with success count, error count, and all extracted data
 */
async function processWithWorkerQueue(
  sites: string[],
  processor: SiteProcessor,
  logErrorFn: (url: string, error: Error | unknown) => Promise<void>,
  outputDir: string,
  concurrencyLimit: number = 10
): Promise<{
  successCount: number,
  errorCount: number,
  downloadErrorCount: number,
  llmErrorCount: number,
  unexpectedErrorCount: number,
  allResults: Record<string, ExtractedData>
}> {
  // Statistics and results
  let successCount = 0;
  let errorCount = 0;
  let downloadErrorCount = 0; // Track download errors separately
  let llmErrorCount = 0;      // Track LLM errors separately
  let unexpectedErrorCount = 0; // Track unexpected errors separately
  
  // Error tracking for detailed reporting
  type ErrorEntry = { url: string; message: string; error?: Error | any; };
  const downloadErrors: ErrorEntry[] = [];
  const llmErrors: ErrorEntry[] = [];
  const unexpectedErrors: ErrorEntry[] = [];
  const allResults: Record<string, ExtractedData> = {};
  
  // Path for consolidated results that updates in real-time (in root directory)
  const consolidatedJsonPath = 'all_results.json'; // File in root directory
  
  // Create/initialize the JSON file with an empty object
  await fsPromises.writeFile(
    consolidatedJsonPath,
    JSON.stringify({}, null, 2),
    'utf-8'
  );
  console.log(`Initialized results file: ${consolidatedJsonPath}`);
  
  // Create a queue of sites to process
  const queue = [...sites];
  let completed = 0;
  const total = queue.length;
  
  // Active workers count
  let activeWorkers = 0;
  
  // Create a promise that resolves when all processing is complete
  const completionPromise = new Promise<void>((resolve) => {
    // Function to process the next site in the queue
    const processNext = async () => {
      if (queue.length === 0) {
        // If no more sites in queue and no active workers, we're done
        if (--activeWorkers === 0) {
          resolve();
        }
        return;
      }
      
      // Get the next site from the queue
      const siteUrl = queue.shift()!;
      completed++;
      console.log(`Processing site: ${siteUrl} (${completed}/${total}) - Queue: ${queue.length} - Active workers: ${activeWorkers}`);
      
      try {
        const result = await processor.processSite(siteUrl);
        
        // Get site name for result storage
        let siteName = '';
        try {
          siteName = new URL(siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`).hostname;
          siteName = siteName.replace(/^www\./, '');
        } catch {
          siteName = siteUrl.replace(/[^a-zA-Z0-9.-]/g, '_').substring(0, 100);
        }
        
        // Check for error type
        if (result.errorType) {
          // Count by error type
          if (result.errorType === 'download') {
            downloadErrorCount++;
            // Add to download errors array
            downloadErrors.push({
              url: siteUrl,
              message: result.error ? (result.error.message || String(result.error)) : "Download failed",
              error: result.error
            });
          } else if (result.errorType === 'llm') {
            llmErrorCount++;
            // Add to LLM errors array
            llmErrors.push({
              url: siteUrl,
              message: result.error ? (result.error.message || String(result.error)) : "LLM processing failed",
              error: result.error
            });
          } else if (result.errorType === 'unexpected') {
            unexpectedErrorCount++;
            // Add to unexpected errors array
            unexpectedErrors.push({
              url: siteUrl,
              message: result.error ? (result.error.message || String(result.error)) : "Unexpected error",
              error: result.error
            });
          }
        }
        
        if (result.success && result.extractedData) {
          // Save result for site
          allResults[siteName] = result.extractedData;
          successCount++;
          
          // Update consolidated JSON file with new result
          await fileOperationQueue.enqueue(async () => {
            try {
              // Read current results
              const currentResults = JSON.parse(await fsPromises.readFile(consolidatedJsonPath, 'utf-8'));
              // Add new result
              currentResults[siteName] = result.extractedData;
              // Write back updated results
              await fsPromises.writeFile(
                consolidatedJsonPath,
                JSON.stringify(currentResults, null, 2),
                'utf-8'
              );
              console.log(`Updated results file with data for: ${siteName}`);
            } catch (err: any) {
              console.error(`Failed to update consolidated results file: ${err.message || String(err)}`);
            }
          });
          
        } else {
          await logErrorFn(siteUrl, result.error || new Error("No extracted data"));
          // Add empty result
          const emptyResult = {
            phone_numbers: [],
            social_media_links: [],
            addresses: []
          };
          
          allResults[siteName] = emptyResult;
          errorCount++;
          
          // Update consolidated JSON file with empty result
          await fileOperationQueue.enqueue(async () => {
            try {
              // Read current results
              const currentResults = JSON.parse(await fsPromises.readFile(consolidatedJsonPath, 'utf-8'));
              // Add empty result
              currentResults[siteName] = emptyResult;
              // Write back updated results
              await fsPromises.writeFile(
                consolidatedJsonPath,
                JSON.stringify(currentResults, null, 2),
                'utf-8'
              );
              console.log(`Updated results file with empty data for: ${siteName}`);
            } catch (err: any) {
              console.error(`Failed to update consolidated results file: ${err.message || String(err)}`);
            }
          });
        }
      } catch (error: any) {
        await logErrorFn(siteUrl, error);
        errorCount++;
        unexpectedErrorCount++;
        
        // Add to unexpected errors array
        unexpectedErrors.push({
          url: siteUrl,
          message: error?.message || String(error)
        });
        
        // Get site name for error result
        let siteName = '';
        try {
          siteName = new URL(siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`).hostname;
          siteName = siteName.replace(/^www\./, '');
        } catch {
          siteName = siteUrl.replace(/[^a-zA-Z0-9.-]/g, '_').substring(0, 100);
        }
        
        // Add empty result for site that had errors
        const emptyResult = {
          phone_numbers: [],
          social_media_links: [],
          addresses: []
        };
        
        allResults[siteName] = emptyResult;
        
        // Update consolidated JSON file with empty result for failed site
        await fileOperationQueue.enqueue(async () => {
          try {
            const currentResults = JSON.parse(await fsPromises.readFile(consolidatedJsonPath, 'utf-8'));
            currentResults[siteName] = emptyResult;
            await fsPromises.writeFile(
              consolidatedJsonPath,
              JSON.stringify(currentResults, null, 2),
              'utf-8'
            );
            console.log(`Updated results file with empty data for failed site: ${siteName}`);
          } catch (err: any) {
            console.error(`Failed to update consolidated results file: ${err.message || String(err)}`);
          }
        });
      }
      
      // Process next site
      processNext();
    };
    
    // Start initial workers (up to concurrency limit)
    const workerCount = Math.min(concurrencyLimit, sites.length);
    activeWorkers = workerCount;
    
    console.log(`Starting ${workerCount} workers to process ${sites.length} sites...`);
    
    for (let i = 0; i < workerCount; i++) {
      processNext();
    }
  });
  
  // Wait for all processing to complete
  await completionPromise;
  
  // Generate error report file
  await generateErrorReport(
    downloadErrors, 
    llmErrors, 
    unexpectedErrors, 
    sites.length, 
    successCount, 
    errorCount, 
    downloadErrorCount, 
    llmErrorCount, 
    unexpectedErrorCount
  );
  
  return { 
    successCount, 
    errorCount, 
    downloadErrorCount,
    llmErrorCount,
    unexpectedErrorCount,
    allResults 
  };
}

// --- Main Application Logic ---
async function runApp() {
  console.log("Starting site processing with 30 parallel threads...");
  const totalStart = performance.now();
  
  try {
    // Ensure output directories exist
    await ensureDirectories();
    
    // Load sites from input file
    const sites = await readInputCsv(INPUT_FILE);
    if (sites.length === 0) {
      console.log("No sites to process. Please add URLs to input.csv");
      return;
    }
    
    // Create site processor
    const config: SiteProcessorConfig = {
      outputDir: OUTPUT_DIR,
      outputJsonDir: OUTPUT_JSON_DIR
    };
    const processor = new SiteProcessor(config);
    
    // Process sites using worker queue (30 threads)
    const { 
      successCount, 
      errorCount, 
      downloadErrorCount, 
      llmErrorCount, 
      unexpectedErrorCount, 
      allResults 
    } = await processWithWorkerQueue(
      sites, 
      processor, 
      logError,
      OUTPUT_DIR,
      30 // maximum concurrency - increased to 30 for higher throughput
    );
    
    // Ensure any remaining LLM items in queue are processed
    const { processRemainingLLMItems } = await import('./llmProcessor');
    console.log("Processing any remaining LLM items in queue...");
    await processRemainingLLMItems();
    
    // Save all results to a single consolidated JSON file in the root directory
    const consolidatedJsonPath = 'all_results.json'; // File in root directory
    await fsPromises.writeFile(
      consolidatedJsonPath,
      JSON.stringify(allResults, null, 2),
      'utf-8'
    );
    console.log(`All results have been saved to: ${consolidatedJsonPath}`);
    
  // Analyze extraction results
  analyzeExtractionResults(allResults, sites.length, downloadErrorCount);

  // Display final summary
    const totalDuration = performance.now() - totalStart;
    const statusReporter = new StatusReporter();
    statusReporter.displayFinalSummary(
      sites.length, 
      successCount, 
      errorCount, 
      downloadErrorCount,
      llmErrorCount,
      unexpectedErrorCount,
      totalDuration
    );
  } catch (error: any) {
    console.error(`Fatal error: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Ensure all necessary directories exist
 */
async function ensureDirectories() {
  try {
    await fsPromises.mkdir(OUTPUT_DIR, { recursive: true });
    await fsPromises.mkdir(OUTPUT_JSON_DIR, { recursive: true });
  } catch (error: any) {
    console.error(`Error creating directories: ${error.message}`);
    throw error;
  }
}

/**
 * Generate a comprehensive error report file
 * @param downloadErrors Array of download errors
 * @param llmErrors Array of LLM errors
 * @param unexpectedErrors Array of unexpected errors
 * @param totalSites Total number of sites processed
 * @param successCount Number of successfully processed sites
 * @param errorCount Total number of sites with errors
 * @param downloadErrorCount Number of sites with download errors
 * @param llmErrorCount Number of sites with LLM errors
 * @param unexpectedErrorCount Number of sites with unexpected errors
 */
async function generateErrorReport(
  downloadErrors: Array<{ url: string; message: string; error?: Error | any }>,
  llmErrors: Array<{ url: string; message: string; error?: Error | any }>,
  unexpectedErrors: Array<{ url: string; message: string; error?: Error | any }>,
  totalSites: number,
  successCount: number,
  errorCount: number,
  downloadErrorCount: number,
  llmErrorCount: number,
  unexpectedErrorCount: number
): Promise<void> {
  try {
    const reportPath = 'error_report.log';
    const timestamp = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
    
    let report = `=== RAPORT ERORI (${timestamp}) ===\n\n`;
    
    // Download errors section
    report += `--- ERORI DESCĂRCARE (${downloadErrorCount}) ---\n`;
    if (downloadErrors.length > 0) {
      downloadErrors.forEach(err => {
        report += `[${err.url}] ${err.message}\n`;
      });
    } else {
      report += "Nu au fost înregistrate erori de descărcare.\n";
    }
    report += "\n";
    
    // LLM errors section
    report += `--- ERORI LLM (${llmErrorCount}) ---\n`;
    if (llmErrors.length > 0) {
      llmErrors.forEach(err => {
        report += `[${err.url}] ${err.message}\n`;
      });
      
      // Save LLM errors to a separate file with full debugging information
      const llmErrorsPath = 'llm_errors_debug.log';
      let llmErrorsContent = `=== ERORI LLM DETALIATE PENTRU DEBUGGING (${timestamp}) ===\n\n`;
      
      llmErrors.forEach(err => {
        llmErrorsContent += `\n----- EROARE PENTRU URL: ${err.url} -----\n\n`;
        
        if (err.error) {
          // Save full error object for debugging
          llmErrorsContent += `MESAJ: ${err.message}\n\n`;
          
        if (err.error instanceof Error) {
          // It's a standard Error object
          llmErrorsContent += `TIP EROARE: ${err.error.constructor.name}\n`;
          llmErrorsContent += `STACK TRACE:\n${err.error.stack || 'No stack trace available'}\n\n`;
          
          // Show retry information if available
          if ((err.error as any).retryCount !== undefined) {
            const retryCount = (err.error as any).retryCount;
            const isRetryable = (err.error as any).isRetryableError;
            
            llmErrorsContent += `INFORMAȚII RETRY:\n`;
            llmErrorsContent += `  Număr de reîncercări: ${retryCount}\n`;
            llmErrorsContent += `  Eroare temporară: ${isRetryable ? 'Da' : 'Nu'}\n`;
            
            if (retryCount > 0) {
              llmErrorsContent += `  Status: Eroare persistentă după ${retryCount} reîncercări\n\n`;
            } else if (isRetryable) {
              llmErrorsContent += `  Status: Eroare temporară dar nu s-a făcut retry (neașteptat)\n\n`;
            } else {
              llmErrorsContent += `  Status: Eroare permanentă (nu poate fi rezolvată prin retry)\n\n`;
            }
          }
          
          // Check for cause (original error) that we attached in the modified code
          if ((err.error as any).cause) {
            const cause = (err.error as any).cause;
            llmErrorsContent += `CAUZA ERORII:\n`;
            llmErrorsContent += `  Tip: ${cause.constructor.name}\n`;
            llmErrorsContent += `  Mesaj: ${cause.message}\n`;
            
            // Include the original stack if available
            if ((err.error as any).originalStack) {
              llmErrorsContent += `STACK TRACE ORIGINAL:\n${(err.error as any).originalStack}\n\n`;
            } else if (cause.stack) {
              llmErrorsContent += `STACK TRACE CAUZĂ:\n${cause.stack}\n\n`;
            }
          }
          
          // Extract all properties from the error object for complete debugging
          llmErrorsContent += "PROPRIETĂȚI SUPLIMENTARE:\n";
          for (const key in err.error) {
            if (key !== 'stack' && key !== 'message' && key !== 'cause' && key !== 'originalStack') {
              try {
                // Use type assertion to avoid TypeScript error with indexing
                const value = JSON.stringify((err.error as any)[key], null, 2);
                llmErrorsContent += `${key}: ${value}\n`;
              } catch (e) {
                llmErrorsContent += `${key}: [Nu poate fi serializat]\n`;
              }
            }
          }
          } else {
            // It's not an Error object
            llmErrorsContent += `EROARE RAW:\n${JSON.stringify(err.error, null, 2)}\n`;
          }
        } else {
          llmErrorsContent += `Nu sunt disponibile detalii suplimentare ale erorii.\n`;
        }
        
        llmErrorsContent += "\n------------------------------------\n\n";
      });
      
      await fsPromises.writeFile(llmErrorsPath, llmErrorsContent, 'utf8');
      console.log(`Erorile LLM pentru debugging au fost salvate în: ${llmErrorsPath}`);
    } else {
      report += "Nu au fost înregistrate erori LLM.\n";
    }
    report += "\n";
    
    // Unexpected errors section
    report += `--- ERORI NEAȘTEPTATE (${unexpectedErrorCount}) ---\n`;
    if (unexpectedErrors.length > 0) {
      unexpectedErrors.forEach(err => {
        report += `[${err.url}] ${err.message}\n`;
      });
    } else {
      report += "Nu au fost înregistrate erori neașteptate.\n";
    }
    report += "\n";
    
    // Summary section
    report += `=== SUMAR ===\n`;
    report += `Total site-uri: ${totalSites}\n`;
    report += `Succes: ${successCount}\n`;
    report += `Erori: ${errorCount}\n`;
    
    if (errorCount > 0) {
      const downloadPct = ((downloadErrorCount / totalSites) * 100).toFixed(1);
      const llmPct = ((llmErrorCount / totalSites) * 100).toFixed(1);
      const unexpectedPct = ((unexpectedErrorCount / totalSites) * 100).toFixed(1);
      
      report += `  - Descărcare: ${downloadErrorCount} (${downloadPct}%)\n`;
      report += `  - LLM: ${llmErrorCount} (${llmPct}%)\n`;
      report += `  - Neașteptate: ${unexpectedErrorCount} (${unexpectedPct}%)\n`;
    }
    
    // Write to file
    await fsPromises.writeFile(reportPath, report, 'utf8');
    console.log(`Raport de erori salvat în: ${reportPath}`);
  } catch (error) {
    console.error(`Failed to generate error report: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Analyze the extraction results and display coverage and fill rates
 * Also saves the results to a file
 * @param allResults Record of all extraction results
 * @param totalInputSites Total number of sites from input.csv
 * @param downloadErrorCount Number of sites that failed to download
 */
function analyzeExtractionResults(
  allResults: Record<string, ExtractedData>, 
  totalInputSites: number, 
  downloadErrorCount: number
): void {
  // Total processed sites (sites in allResults)
  const processedSites = Object.keys(allResults).length;
  
  // Successfully crawled = sites that were attempted minus those that failed to download
  const successfullyCrawled = totalInputSites - downloadErrorCount;
  const failedToCrawl = downloadErrorCount;
  
  // Calculate coverage percentages
  const crawledPercentage = totalInputSites > 0 ? ((successfullyCrawled / totalInputSites) * 100).toFixed(2) : "0.00";
  const failedPercentage = totalInputSites > 0 ? ((failedToCrawl / totalInputSites) * 100).toFixed(2) : "0.00";
  
  // Count sites with each datapoint type
  let sitesWithPhones = 0;
  let sitesWithSocialMedia = 0;
  let sitesWithAddresses = 0;
  
  // Count total datapoints
  let totalPhoneNumbers = 0;
  let totalSocialLinks = 0;
  let totalAddresses = 0;
  
  Object.values(allResults).forEach(data => {
    // Check if data arrays have valid content (not empty arrays and not "nothing found")
    if (data.phone_numbers.length > 0 && (data.phone_numbers[0] !== "nothing found")) {
      sitesWithPhones++;
      totalPhoneNumbers += data.phone_numbers.length;
    }
    
    if (data.social_media_links.length > 0 && (data.social_media_links[0] !== "nothing found")) {
      sitesWithSocialMedia++;
      totalSocialLinks += data.social_media_links.length;
    }
    
    if (data.addresses.length > 0 && (data.addresses[0] !== "nothing found")) {
      sitesWithAddresses++;
      totalAddresses += data.addresses.length;
    }
  });
  
  // Calculate fill rates based on processed sites
  const phonesFillRate = processedSites > 0 ? ((sitesWithPhones / processedSites) * 100).toFixed(2) : "0.00";
  const socialFillRate = processedSites > 0 ? ((sitesWithSocialMedia / processedSites) * 100).toFixed(2) : "0.00";
  const addressesFillRate = processedSites > 0 ? ((sitesWithAddresses / processedSites) * 100).toFixed(2) : "0.00";
  const overallFillRate = processedSites > 0 ? (((sitesWithPhones + sitesWithSocialMedia + sitesWithAddresses) / (processedSites * 3)) * 100).toFixed(2) : "0.00";
  
  // Total datapoints
  const totalDatapoints = totalPhoneNumbers + totalSocialLinks + totalAddresses;
  
  // Display results
  console.log("\n=== EXTRACTION ANALYSIS ===");
  console.log(`Total websites in input: ${totalInputSites}`);
  console.log(`Successfully crawled: ${successfullyCrawled}/${totalInputSites} (${crawledPercentage}%)`);
  console.log(`Failed to crawl: ${failedToCrawl}/${totalInputSites} (${failedPercentage}%)`);
  
  console.log("\nCoverage (sites with data):");
  console.log(`- Phone Numbers: ${sitesWithPhones}/${processedSites} sites (${phonesFillRate}%)`);
  console.log(`- Social Media Links: ${sitesWithSocialMedia}/${processedSites} sites (${socialFillRate}%)`);
  console.log(`- Addresses: ${sitesWithAddresses}/${processedSites} sites (${addressesFillRate}%)`);
  console.log(`- Overall Fill Rate: ${overallFillRate}%`);
  
  console.log("\nExtracted Datapoints:");
  console.log(`- Phone Numbers: ${totalPhoneNumbers} datapoints`);
  console.log(`- Social Media Links: ${totalSocialLinks} datapoints`);
  console.log(`- Addresses: ${totalAddresses} datapoints`);
  console.log(`- Total Datapoints: ${totalDatapoints}`);
  
  console.log("\nSummary:");
  console.log(`Successfully crawled ${successfullyCrawled} websites and extracted ${totalDatapoints} datapoints.`);
  console.log(`Average datapoints per site: ${(totalDatapoints / Math.max(processedSites, 1)).toFixed(2)}`);
  console.log("=============================\n");
  
  // Create text for the file
  const reportText = `
========== CRAWLING AND EXTRACTION ANALYSIS ==========

COVERAGE STATISTICS
------------------
Total number of websites: ${totalInputSites}
Successfully crawled websites: ${successfullyCrawled} (${crawledPercentage}%)
Failed to crawl: ${failedToCrawl} (${failedPercentage}%)

EXTRACTION FILL RATES
--------------------
Phone Numbers:
  - Websites with phone numbers: ${sitesWithPhones}/${processedSites} sites (${phonesFillRate}%)
  - Total phone numbers extracted: ${totalPhoneNumbers}

Social Media Links:
  - Websites with social links: ${sitesWithSocialMedia}/${processedSites} sites (${socialFillRate}%)
  - Total social links extracted: ${totalSocialLinks}

Addresses:
  - Websites with addresses: ${sitesWithAddresses}/${processedSites} sites (${addressesFillRate}%)
  - Total addresses extracted: ${totalAddresses}

OVERALL STATISTICS
-----------------
Total datapoints extracted: ${totalDatapoints}
Average datapoints per processed site: ${(totalDatapoints / Math.max(processedSites, 1)).toFixed(2)}
Overall fill rate: ${overallFillRate}%
`.trim();

  // Save the report to a file
  const reportPath = 'crawling_analysis.txt';
  fsPromises.writeFile(reportPath, reportText, 'utf8')
    .then(() => {
      console.log(`Analysis saved to file: ${reportPath}`);
    })
    .catch(err => {
      console.error(`Failed to save analysis report: ${err.message}`);
    });
}

/**
 * Log error to a file
 * @param url URL that caused the error
 * @param error The error object
 */
async function logError(url: string, error: Error | unknown): Promise<void> {
  try {
    let hostname = 'unknown_host';
    try {
      hostname = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
    } catch {
      hostname = url.replace(/[^a-zA-Z0-9.-]/g, '_').substring(0, 100);
    }
    
    const sanitizedHostname = hostname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const errorFilePath = path.join(OUTPUT_DIR, sanitizedHostname + ".error.log");
    
    // Safely extract error information
    let errorMessage = `${new Date().toISOString()} - ${url}\n`;
    
    if (error instanceof Error) {
      errorMessage += `Error: ${error.message}\nStack: ${error.stack || 'No stack trace'}\n\n`;
    } else {
      errorMessage += `Error: ${String(error)}\nStack: No stack trace\n\n`;
    }
    
    await fsPromises.appendFile(errorFilePath, errorMessage, 'utf-8');
  } catch (logError) {
    console.error(`Failed to write error log: ${logError instanceof Error ? logError.message : String(logError)}`);
  }
}

// Run the application
(async () => {
  try {
    await runApp();
  } catch (error: any) {
    console.error(`Unhandled error: ${error.message}`);
    process.exit(1);
  }
})();
