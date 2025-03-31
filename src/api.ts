import express, { Request, Response } from 'express';
import { Client } from '@elastic/elasticsearch';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const ES_NODE = process.env.ELASTICSEARCH_NODE || 'http://localhost:9200';
const ES_INDEX = process.env.ELASTICSEARCH_INDEX || 'websites_data';

// Create Elasticsearch client
const client = new Client({ node: ES_NODE });

// Interface for the document structure
interface CompanyDocument {
  domain: string;
  company_commercial_name?: string;
  company_legal_name?: string;
  company_all_available_names?: string;
  phone_numbers: string[];
  social_media_links: string[];
  addresses: string[];
  timestamp: string;
}

/**
 * Normalize a phone number by removing all non-digit characters.
 */
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

/**
 * Format a phone number to a standard format (XXX) XXX-XXXX if possible
 */
function formatPhoneNumber(phoneNumber: string): string {
  // Get just the digits
  const cleaned = normalizePhone(phoneNumber);
  
  // Format as (XXX) XXX-XXXX for US numbers
  if (cleaned.length === 10) {
    return `(${cleaned.substring(0, 3)}) ${cleaned.substring(3, 6)}-${cleaned.substring(6, 10)}`;
  }
  
  // Return original if we can't format
  return phoneNumber;
}

app.post('/match', async (req: Request, res: Response) => {
  // Input: input_name, input_phone, input_website, input_facebook
  const { input_name, input_phone, input_website, input_facebook } = req.body;

  const shouldClauses: any[] = [];

  if (input_name) {
    shouldClauses.push({
      multi_match: {
        query: input_name,
        fields: [
          'company_commercial_name',
          'company_all_available_names',
          'company_legal_name'
        ],
        fuzziness: 'AUTO'
      }
    });
  }

  if (input_phone) {
    // For phone matching, we'll need to:
    // 1. Normalize the input phone
    const normalizedInput = normalizePhone(input_phone);
    
    // 2. Get documents with phone_numbers
    shouldClauses.push({
      exists: {
        field: "phone_numbers"
      }
    });
    
    // We'll handle the actual matching in post-processing
  }

  if (input_website) {
    // Normalize website to lowercase for exact matching
    shouldClauses.push({
      term: { domain: input_website.toLowerCase() }
    });
  }

  if (input_facebook) {
    shouldClauses.push({
      term: { social_media_links: input_facebook }
    });
  }

  if (shouldClauses.length === 0) {
    return res.status(400).json({ error: 'No input provided' });
  }

  try {
    // If we're matching by phone, get more potential matches
    const size = input_phone ? 100 : 1;
    
    const response = await client.search<CompanyDocument>({
      index: ES_INDEX,
      query: {
        bool: {
          should: shouldClauses,
          minimum_should_match: 1
        }
      },
      size: size
    });

    const hits = response.hits.hits;
    if (hits.length === 0) {
      return res.status(404).json({ error: 'No matching company found' });
    }

    // If we're matching by phone, filter the results
    if (input_phone) {
      const normalizedInput = normalizePhone(input_phone);
      
      const phoneMatches = hits.filter(hit => {
        const source = hit._source;
        if (!source || !source.phone_numbers || !Array.isArray(source.phone_numbers)) {
          return false;
        }
        
        return source.phone_numbers.some(phone => {
          return normalizePhone(phone) === normalizedInput;
        });
      });
      
      if (phoneMatches.length > 0) {
        const source = phoneMatches[0]!._source;
        if (!source) {
          return res.status(500).json({ error: 'Matching document has no source data' });
        }
        
        // Format the phone numbers before returning
        if (source.phone_numbers && Array.isArray(source.phone_numbers)) {
          source.phone_numbers = source.phone_numbers.map(phone => formatPhoneNumber(phone));
        }
        
        return res.json(source);
      }
    }

    const source = hits[0]!._source;
    if (!source) {
      return res.status(500).json({ error: 'Matching document has no source data' });
    }

    // Format the phone numbers before returning
    if (source.phone_numbers && Array.isArray(source.phone_numbers)) {
      source.phone_numbers = source.phone_numbers.map(phone => formatPhoneNumber(phone));
    }

    return res.json(source);
  } catch (error) {
    console.error('Search error', error);
    return res.status(500).json({ error: 'Search failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
});