// /mx-lookup-check/route.js

import { NextResponse } from "next/server";
import dns from 'dns';
import { promisify } from 'util';
import geminiHelper from '@/utils/geminiHelper'; // Import geminiHelper

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

    // Determine possible provider and login page
    const possibleProvider = await geminiHelper.getPossibleProvider(mxRecords, domain);
    let loginPage = 'unknown';

    switch (possibleProvider.toLowerCase()) {
      case 'gmail':
        loginPage = 'https://mail.google.com/';
        break;
      case 'outlook':
        loginPage = 'https://outlook.live.com/mail/';
        break;
      case 'yahoo':
        loginPage = 'https://mail.yahoo.com/';
        break;
      case 'godaddy':
        loginPage = 'https://sso.godaddy.com/';
        break;
      case 'zoho':
        loginPage = 'https://mail.zoho.com/';
        break;
      case 'protonmail':
        loginPage = 'https://mail.proton.me/';
        break;
      default:
        loginPage = `https://mail.${domain}`; // Generic attempt
        break;
    }

    // Check if any valid MX records were found
    if (!mxRecords || mxRecords.length === 0 || !mxRecords[0].exchange) {
      return { email, domain, recordExists: false, recordData: null, loginPage, possibleProvider };
    }

    // If MX records found, return them along with domain, loginPage, and possibleProvider
    return { email, domain, recordExists: true, recordData: mxRecords, loginPage, possibleProvider };
  } catch (err) {
    // Handle any DNS resolution errors or invalid email formats
    console.log(`Error resolving MX records for ${email}: ${err.message}`);
    const domain = email.split('@')[1] || 'unknown'; // Ensure domain is available even on error
    return { email, domain, recordExists: false, error: `Error resolving MX records: ${err.message}`, loginPage: 'unknown', possibleProvider: 'unknown' };
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
