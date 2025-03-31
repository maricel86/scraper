import { DownloadResult, DownloadStatus } from '../types';

/**
 * Interface for all download strategies
 */
export interface DownloadStrategy {
  /**
   * Unique name of the strategy
   */
  readonly name: string;
  
  /**
   * Protocol used by this strategy
   */
  readonly protocol: string;
  
  /**
   * Method used by this strategy (Local/External/OnlineSearch)
   */
  readonly method: string;
  
  /**
   * Attempts to download content from the provided URL
   * 
   * @param url The URL to download
   * @returns A Promise resolving to the download result
   * @throws Error if download fails
   */
  download(url: string): Promise<DownloadResult>;
  
  /**
   * Checks if this strategy is applicable for the given URL and error
   * 
   * @param url The URL to check
   * @param previousError Error from previous strategy (if any)
   * @returns true if this strategy should be tried, false otherwise
   */
  isApplicable(url: string, previousError?: Error): boolean;
}

/**
 * Base class for all download strategies
 */
export abstract class BaseDownloadStrategy implements DownloadStrategy {
  constructor(
    public readonly name: string,
    public readonly protocol: string,
    public readonly method: string
  ) {}
  
  abstract download(url: string): Promise<DownloadResult>;
  
  isApplicable(url: string, previousError?: Error): boolean {
    // Default implementation always returns true
    // Subclasses should override this when needed
    return true;
  }
}

/**
 * Chain of responsibility for download strategies
 */
export class DownloadStrategyChain {
  private strategies: DownloadStrategy[] = [];
  
  /**
   * Add a strategy to the chain
   */
  addStrategy(strategy: DownloadStrategy): DownloadStrategyChain {
    this.strategies.push(strategy);
    return this;
  }
  
  /**
   * Execute the chain of download strategies
   * 
   * @param url The URL to download
   * @param onAttempt Optional callback for each attempt
   * @returns A Promise resolving to the download result and status
   */
  async execute(
    url: string, 
    onAttempt?: (strategy: DownloadStrategy, status: DownloadStatus) => void
  ): Promise<{ result: DownloadResult, status: DownloadStatus }> {
    let lastError: Error | undefined;
    
    for (const strategy of this.strategies) {
      if (!strategy.isApplicable(url, lastError)) {
        continue;
      }
      
      try {
        const result = await strategy.download(url);
        
        const status: DownloadStatus = {
          success: true,
          protocol: strategy.protocol,
          method: strategy.method,
          details: `Downloaded using ${strategy.name}`
        };
        
        if (onAttempt) {
          onAttempt(strategy, status);
        }
        
        return { result, status };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        const status: DownloadStatus = {
          success: false,
          protocol: strategy.protocol,
          method: strategy.method,
          details: `Failed: ${lastError.message}`,
          error: lastError
        };
        
        if (onAttempt) {
          onAttempt(strategy, status);
        }
      }
    }
    
    // If we get here, all strategies failed
    throw lastError || new Error('All download strategies failed');
  }
}
