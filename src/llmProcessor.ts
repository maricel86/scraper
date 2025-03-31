import { LLM_SYSTEM_PROMPT } from "./prompt/llmPrompt";

export interface ExtractedData {
  phone_numbers: string[];
  social_media_links: string[];
  addresses: string[];
}

// Input type for batch processing
interface LLMInput {
  text: string;
  siteName: string;
}

// Singleton batch processor to accumulate requests
class LLMBatchProcessor {
  private static instance: LLMBatchProcessor;
  private queue: LLMInput[] = [];
  private batchSize: number = 20; // Increased from 15 to 30 for higher throughput
  private processing: boolean = false;
  private pendingResolvers: Map<string, { 
    resolve: (data: ExtractedData) => void, 
    reject: (error: Error) => void 
  }> = new Map();
  
  private constructor() {}
  
  public static getInstance(): LLMBatchProcessor {
    if (!LLMBatchProcessor.instance) {
      LLMBatchProcessor.instance = new LLMBatchProcessor();
    }
    return LLMBatchProcessor.instance;
  }
  
  // Queue an item for processing
  public queueItem(input: LLMInput): Promise<ExtractedData> {
    return new Promise((resolve, reject) => {
      // Store the resolvers for this siteName
      this.pendingResolvers.set(input.siteName, { resolve, reject });
      
      // Add to queue
      this.queue.push(input);
      
      console.log(`Queued ${input.siteName} for LLM processing (${this.queue.length}/${this.batchSize} in batch)`);
      
      // Process batch if we have enough items
      if (this.queue.length >= this.batchSize) {
        this.processBatch();
      } else if (!this.processing && this.queue.length > 0) {
        // Start a timer to process any remaining items if we don't reach batch size
        setTimeout(() => {
          if (this.queue.length > 0 && !this.processing) {
            this.processBatch();
          }
        }, 1000); // 1 second delay
      }
    });
  }
  
  // Force process any remaining items
  public async processRemainingItems(): Promise<void> {
    if (this.queue.length > 0 && !this.processing) {
      await this.processBatch();
    }
  }
  
  // Process the current batch
  private async processBatch(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    
    // Take items from the queue
    const currentBatch = [...this.queue];
    this.queue = [];
    
    console.log(`Processing batch of ${currentBatch.length} sites with LLM...`);
    
    try {
      // Process the batch
      const results = await this.callLLMWithBatch(currentBatch);
      
      // Resolve all the promises with their respective results
      for (const siteName of Object.keys(results)) {
        const resolver = this.pendingResolvers.get(siteName);
        if (resolver) {
          const result = results[siteName] || {
            phone_numbers: [],
            social_media_links: [],
            addresses: []
          };
          resolver.resolve(result);
          this.pendingResolvers.delete(siteName);
        }
      }
      
      // Handle any missing sites (not found in results)
      for (const input of currentBatch) {
        if (!results[input.siteName]) {
          const resolver = this.pendingResolvers.get(input.siteName);
          if (resolver) {
            const emptyResult: ExtractedData = {
              phone_numbers: [],
              social_media_links: [],
              addresses: []
            };
            resolver.resolve(emptyResult);
            this.pendingResolvers.delete(input.siteName);
          }
        }
      }
    } catch (error) {
      // If batch processing fails, reject all promises
      for (const input of currentBatch) {
        const resolver = this.pendingResolvers.get(input.siteName);
        if (resolver) {
          resolver.reject(error as Error);
          this.pendingResolvers.delete(input.siteName);
        }
      }
    } finally {
      this.processing = false;
      
      // Process next batch if more items are in queue
      if (this.queue.length >= this.batchSize) {
        this.processBatch();
      }
    }
  }
  
  /**
   * Determine if an error is retryable
   * @param error The error to check
   * @returns true if the error is temporary and can be retried
   */
  private isRetryableError(error: any): boolean {
    // Network errors (fetch failed) are temporary
    if (error instanceof TypeError && error.message === 'fetch failed') {
      return true;
    }
    
    // Rate limiting errors from the API
    if (error?.message?.includes('rate limit') || 
        error?.message?.includes('quota') || 
        error?.message?.includes('429')) {
      return true;
    }
    
    // Connection timeout errors
    if (error?.message?.includes('timeout') || 
        error?.message?.includes('socket hang up')) {
      return true;
    }
    
    // Other temporary network issues
    if (error?.message?.includes('ECONNRESET') || 
        error?.message?.includes('ETIMEDOUT') ||
        error?.message?.includes('network error')) {
      return true;
    }
    
    return false;
  }
  
  // Make the actual API call with a batch of items
  private async callLLMWithBatch(batch: LLMInput[]): Promise<Record<string, ExtractedData>> {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not set in environment variables.");
    }
    
    // Calculate total text size
    const totalBytes = batch.reduce((sum, item) => 
      sum + Buffer.byteLength(item.text, 'utf8'), 0);
    
    console.log(`Making API call to process batch of ${batch.length} sites (${totalBytes} total bytes)...`);
    
    // Prepare parts for each site in the batch
    const parts = batch.map(item => ({
      text: `------SITE NAME:${item.siteName}-------  CONTENT:${item.text} `
    }));
    
    // Retry parameters
    const maxRetries = 2;  // Try up to 3 times (initial + 2 retries)
    let retryCount = 0;
    let lastError: any = null;
    
    // Retry loop
    while (retryCount <= maxRetries) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: LLM_SYSTEM_PROMPT }] },
              contents: [{ parts }],
              generationConfig: {
                temperature: 1,
                maxOutputTokens: 8192,
              }
            })
          }
        );
        
        const json = await response.json();
        if (json.error) {
          throw new Error(`Gemini API error: ${JSON.stringify(json.error)}`);
        }
        
        console.log(`LLM response: ${JSON.stringify(json)}`);
        
        let resultText = "";
        if (json.candidates && json.candidates.length > 0) {
          const returnedParts = json.candidates[0].content.parts || [];
          const textPart = returnedParts.find((p: any) => p.text);
          if (textPart && textPart.text) {
            resultText = textPart.text.trim();
          }
        }
        
        if (!resultText) {
          throw new Error("No valid response from Gemini");
        }
        
        // Clean any markdown formatting from the response
        const jsonText = resultText.replace(/```json\n?/g, "").replace(/```/g, "");
        
        // Parse the response as an array of results
        const extractedDataArray = JSON.parse(jsonText) as Array<{
          site_name: string;
          phone_numbers: string[];
          social_media_links: string[];
          addresses: string[];
        }>;
        
        // Convert to a record keyed by site name
        const results: Record<string, ExtractedData> = {};
        for (const item of extractedDataArray) {
          results[item.site_name] = {
            phone_numbers: item.phone_numbers || [],
            social_media_links: item.social_media_links || [],
            addresses: item.addresses || []
          };
        }
        
        // Success! Return the results
        if (retryCount > 0) {
          console.log(`Successfully recovered after ${retryCount} retry attempts`);
        }
        return results;
        
      } catch (error) {
        lastError = error;
        console.error(`Error in batch LLM processing (attempt ${retryCount + 1}/${maxRetries + 1}):`, error);
        
        // Check if error is retryable and we have retries left
        if (this.isRetryableError(error) && retryCount < maxRetries) {
          retryCount++;
          // Use exponential backoff: 1s, 2s, 4s, etc.
          const delayMs = 1000 * Math.pow(2, retryCount - 1);
          console.log(`Retryable error detected, retrying in ${delayMs}ms (retry ${retryCount}/${maxRetries})...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
        
        // We've exhausted retries or error is not retryable
        // Create a detailed error that includes the original error
        const errorMessage = error instanceof Error ? error.message : String(error);
        const detailedError = new Error(`LLM batch processing failed: ${errorMessage}`);
        
        // Add retry information
        (detailedError as any).retryCount = retryCount;
        (detailedError as any).isRetryableError = this.isRetryableError(error);
        
        // Preserve the original error as cause (standard Error property)
        if (error instanceof Error) {
          (detailedError as any).cause = error;
          
          // Copy stack trace if available
          if (error.stack) {
            (detailedError as any).originalStack = error.stack;
          }
          
          // Copy any other properties from the original error
          for (const key in error) {
            if (Object.prototype.hasOwnProperty.call(error, key) && key !== 'message' && key !== 'stack') {
              (detailedError as any)[key] = (error as any)[key];
            }
          }
        } else {
          // If it's not an Error object, store the original as is
          (detailedError as any).originalError = error;
        }
        
        throw detailedError;
      }
    }
    
    // This should never be reached, but TypeScript requires a return statement
    throw new Error("Failed to execute LLM batch processing after retries");
  }
}

// Backward-compatible function that uses the batch processor
export async function processWithLLM(inputText: string, siteName: string): Promise<ExtractedData> {
  console.log(`Queueing site ${siteName} (${Buffer.byteLength(inputText, 'utf8')} bytes) for LLM processing...`);
  
  // Get batch processor and queue the item
  const batchProcessor = LLMBatchProcessor.getInstance();
  return batchProcessor.queueItem({ text: inputText, siteName });
}

// Function to force process any remaining items in the queue
export async function processRemainingLLMItems(): Promise<void> {
  const batchProcessor = LLMBatchProcessor.getInstance();
  return batchProcessor.processRemainingItems();
}
