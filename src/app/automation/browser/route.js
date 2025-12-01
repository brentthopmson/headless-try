import { NextResponse } from "next/server";
import puppeteer from 'puppeteer';
import aiHelper from '@/utils/aiHelper';

export async function POST(request) {
    try {
        const { url, task } = await request.json();

        // Generate browser automation steps using AI
        const automationPlan = await aiHelper.generateBrowserActions(task);

        // Launch browser and execute the plan
        const browser = await puppeteer.launch({ headless: "new" });
        const page = await browser.newPage();
        
        await page.goto(url);

        // Execute the AI-generated actions
        const result = await executeAutomationPlan(page, automationPlan);

        // Analyze the results
        const analysis = await aiHelper.analyzeContent(
            JSON.stringify(result),
            "Analyze the automation results and provide insights"
        );

        await browser.close();

        const response = NextResponse.json({ result, analysis }, { status: 200 });
        response.headers.set("Access-Control-Allow-Origin", "*");
        return response;

    } catch (error) {
        // Use AI to process the error
        const errorAnalysis = await aiHelper.processError(
            error.message,
            "Browser automation task"
        );

        const response = NextResponse.json({ 
            error: error.message,
            suggestions: errorAnalysis
        }, { status: 500 });
        
        response.headers.set("Access-Control-Allow-Origin", "*");
        return response;
    }
}

async function executeAutomationPlan(page, plan) {
    const results = [];
    
    for (const action of plan.actions) {
        try {
            switch (action.type) {
                case 'click':
                    await page.click(action.selector);
                    break;
                case 'type':
                    await page.type(action.selector, action.text);
                    break;
                case 'wait':
                    await page.waitForSelector(action.selector);
                    break;
                case 'extract':
                    const data = await page.evaluate((selector) => {
                        return document.querySelector(selector)?.textContent;
                    }, action.selector);
                    results.push({ type: 'extraction', data });
                    break;
            }
            results.push({ status: 'success', action });
        } catch (error) {
            results.push({ status: 'error', action, error: error.message });
        }
    }
    
    return results;
}

export async function OPTIONS() {
    const response = NextResponse.json({}, { status: 200 });
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type");
    return response;
}