// /mx-check/route.js

import { NextResponse } from "next/server";
import dns from 'dns';
import { promisify } from 'util';

const resolveMx = promisify(dns.resolveMx);

async function checkMxRecord(email) {
  try {
    // Split email to extract domain
    const domain = email.split('@')[1];
    
    // If email doesn't have a valid domain, return error
    if (!domain) {
      return { email, recordExists: false, error: 'Invalid email format' };
    }

    // Resolve MX records
    const mxRecords = await resolveMx(domain);

    // Check if any valid MX records were found
    if (!mxRecords || mxRecords.length === 0 || !mxRecords[0].exchange) {
      return { email, recordExists: false, recordData: null };
    }

    // If MX records found, return them
    return { email, recordExists: true, recordData: mxRecords };
  } catch (err) {
    // Handle any DNS resolution errors or invalid email formats
    console.log(`Error resolving MX records for ${email}: ${err.message}`);
    return { email, recordExists: false, error: `Error resolving MX records: ${err.message}` };
  }
}

export async function POST(request) {
  try {
    const { emails } = await request.json(); // Parse JSON body

    // Check for missing or invalid email list
    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return NextResponse.json({ error: "Missing or invalid email list" }, { status: 400 });
    }

    // Limit the emails to 100
    const emailList = emails.slice(0, 100);

    // Process all emails concurrently
    const results = await Promise.all(emailList.map(email => checkMxRecord(email)));

    return NextResponse.json({ results }, { status: 200 });
  } catch (error) {
    // General error handling for JSON parsing or other unexpected errors
    return NextResponse.json({ error: "An error occurred processing the request" }, { status: 500 });
  }
}
