import { BaseDownloadStrategy } from './downloadStrategy';
import { DownloadResult } from '../types';
import got from 'got';

/**
 * Strategy for downloading using external service with HTTP
 */
export class ExternalHttpStrategy extends BaseDownloadStrategy {
  constructor() {
    super('External HTTP', 'HTTP', 'External');
  }
  
  isApplicable(url: string, previousError?: Error): boolean {
    // This strategy should be tried if External HTTPS strategy failed
    if (!previousError) {
      return false; // Should be tried only after External HTTPS fails
    }
    
    const errorMsg = previousError.message.toLowerCase();
    return errorMsg.includes('external https download failed');
  }
  
  async download(url: string): Promise<DownloadResult> {
    // Ensure URL uses HTTP
    const httpUrl = url.replace(/^https:\/\//i, 'http://');
    
    // Download content using Jina reader service
    const content = await this.downloadUsingExternalService(httpUrl);
    const size = Buffer.byteLength(content, 'utf8');
    
    // External service doesn't provide links
    return {
      content,
      effectiveUrl: httpUrl,
      size,
      links: [], // External service doesn't extract links
      isMarkdown: true // Jina returns markdown-like plain text
    };
  }
  
  /**
   * Downloads website content as plain text using the Jina AI Reader service (r.jina.ai).
   * @param url The URL of the site to download.
   * @returns A promise that resolves to the downloaded plain text content or rejects on error.
   */
  private async downloadUsingExternalService(url: string): Promise<string> {
    const jinaUrl = `https://r.jina.ai/${url}`;

    try {
      const response = await got(jinaUrl, {
        headers: {
          'Accept': 'text/plain, text/markdown;q=0.9, */*;q=0.8',
          'User-Agent': 'Veridion-Site-Processor/1.0 (External Downloader)'
        },
        timeout: { request: 30000 },
        retry: { limit: 0 }
      });

      if (response.statusCode !== 200) {
        throw new Error(`Jina Reader service returned status code ${response.statusCode}`);
      }

      return response.body;
    } catch (error: any) {
      throw new Error(`External HTTP download failed: ${error.message}`);
    }
  }
}
