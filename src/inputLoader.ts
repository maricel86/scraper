import { promises as fsPromises } from 'fs'; // Use named import for promises

/**
 * Reads the input CSV file and returns an array of site URLs.
 * @param filePath The path to the input CSV file. Defaults to 'input.csv'.
 * @returns A promise that resolves to an array of trimmed, non-empty URLs.
 */
export async function readInputCsv(filePath: string = 'input.csv'): Promise<string[]> {
  try {
    const content = await fsPromises.readFile(filePath, 'utf-8'); // Use fsPromises
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  } catch (error) {
    console.error(`Error reading input file ${filePath}:`, error);
    throw new Error(`Could not read input file: ${filePath}`);
  }
}
