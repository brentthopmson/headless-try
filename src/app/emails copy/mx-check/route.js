// /mx-lookup-check/route.js

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

    const response = NextResponse.json({ results }, { status: 200 });
    
    // Add CORS headers
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type");

    return response;
  } catch (error) {
    // General error handling for JSON parsing or other unexpected errors
    const response = NextResponse.json({ error: "An error occurred processing the request" }, { status: 500 });
    
    // Add CORS headers
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type");

    return response;
  }
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const emailsParam = url.searchParams.get("emails");

    // Check for missing or invalid email list
    if (!emailsParam) {
      return NextResponse.json({ error: "Missing or invalid email list" }, { status: 400 });
    }

    const emails = emailsParam.split(',');

    // Limit the emails to 100
    const emailList = emails.slice(0, 100);

    // Process all emails concurrently
    const results = await Promise.all(emailList.map(email => checkMxRecord(email)));

    const response = NextResponse.json({ results }, { status: 200 });
    
    // Add CORS headers
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type");

    return response;
  } catch (error) {
    // General error handling for JSON parsing or other unexpected errors
    const response = NextResponse.json({ error: "An error occurred processing the request" }, { status: 500 });
    
    // Add CORS headers
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type");

    return response;
  }
}

export async function OPTIONS() {
  // Preflight response for OPTIONS requests
  const response = NextResponse.json({}, { status: 200 });
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  
  return response;
}
