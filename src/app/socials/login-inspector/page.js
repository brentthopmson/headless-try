"use client";

import { useState, useRef, useEffect } from "react";

export default function LoginInspectorPage() {
  const [sessionId, setSessionId] = useState("default");
  const [platform, setPlatform] = useState("twitter");
  const [customUrl, setCustomUrl] = useState("");
  const [status, setStatus] = useState("Ready");
  const [browserActive, setBrowserActive] = useState(false);
  const [pageUrl, setPageUrl] = useState("");
  const [pageTitle, setPageTitle] = useState("");
  const [inspectionData, setInspectionData] = useState(null);
  const [generatedConfig, setGeneratedConfig] = useState(null);
  const [log, setLog] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("inputs");
  const [navHistory, setNavHistory] = useState([]);
  const [customCode, setCustomCode] = useState("");
  const logRef = useRef(null);

  const platforms = [
    { value: "twitter", label: "Twitter / X" },
    { value: "tiktok", label: "TikTok" },
    { value: "instagram", label: "Instagram" },
    { value: "facebook", label: "Facebook" },
    { value: "messenger", label: "Messenger" },
    { value: "linkedin", label: "LinkedIn" },
    { value: "outlook", label: "Outlook / Hotmail" },
    { value: "gmail", label: "Gmail" },
    { value: "yahoo", label: "Yahoo" },
    { value: "protonmail", label: "ProtonMail" },
    { value: "quora", label: "Quora" },
    { value: "reddit", label: "Reddit" },
    { value: "discord", label: "Discord" },
    { value: "telegram", label: "Telegram Web" },
    { value: "whatsapp", label: "WhatsApp Web" },
    { value: "spotify", label: "Spotify" },
    { value: "twitch", label: "Twitch" },
    { value: "github", label: "GitHub" },
    { value: "microsoft", label: "Microsoft Login" },
    { value: "google", label: "Google Accounts" },
    { value: "amazon", label: "Amazon" },
    { value: "apple", label: "Apple ID" },
    { value: "netflix", label: "Netflix" },
    { value: "custom", label: "Custom URL..." },
  ];

  const addLog = (message, type = "info") => {
    const timestamp = new Date().toLocaleTimeString();
    setLog(prev => [...prev, { timestamp, message, type }]);
  };

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log]);

  const callApi = async (body) => {
    setLoading(true);
    try {
      const res = await fetch("/socials/login-inspector/api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, sessionId }),
      });
      const data = await res.json();
      return data;
    } catch (err) {
      addLog(`Network error: ${err.message}`, "error");
      return { error: err.message };
    } finally {
      setLoading(false);
    }
  };

  const handleLaunch = async () => {
    addLog(`Launching browser for ${platform}...`, "action");
    const url = platform === "custom" ? customUrl : null;
    const data = await callApi({ action: "launch", platform, url: url || undefined });

    if (data.error) {
      addLog(`Error: ${data.error}`, "error");
      setStatus("Error launching");
      return;
    }

    setBrowserActive(true);
    setPageUrl(data.url || "");
    setPageTitle(data.inspection?.title || "");
    setInspectionData(data.inspection);
    setStatus(`Browser launched - ${platform}`);
    addLog(`Browser launched successfully`, "success");
    addLog(`Page: ${data.inspection?.title || data.url}`, "info");
    addLog(`Found ${data.inspection?.inputs?.length || 0} inputs, ${data.inspection?.buttons?.length || 0} buttons`, "info");
  };

  const handleInspect = async () => {
    addLog("Inspecting current page...", "action");
    const data = await callApi({ action: "inspect" });

    if (data.error) {
      addLog(`Error: ${data.error}`, "error");
      return;
    }

    setInspectionData(data.inspection);
    setPageUrl(data.inspection?.url || "");
    setPageTitle(data.inspection?.title || "");
    setStatus("Inspected");
    addLog(`Inspection complete: ${data.inspection?.inputs?.length || 0} inputs, ${data.inspection?.buttons?.length || 0} buttons`, "success");
  };

  const handleNavigate = async (url) => {
    if (!url) return;
    addLog(`Navigating to: ${url}`, "action");
    const data = await callApi({ action: "navigate", url });

    if (data.error) {
      addLog(`Error: ${data.error}`, "error");
      return;
    }

    setInspectionData(data.inspection);
    setPageUrl(data.url || data.inspection?.url || "");
    setPageTitle(data.inspection?.title || "");
    addLog(`Navigated to: ${data.inspection?.title || data.url}`, "success");
  };

  const handleSave = async () => {
    addLog("Generating platform config...", "action");
    const data = await callApi({ action: "save", platform });

    if (data.error) {
      addLog(`Error: ${data.error}`, "error");
      return;
    }

    setGeneratedConfig(data.config);
    addLog(`Config generated successfully`, "success");
    addLog(`Summary: ${data.inspectionSummary?.inputsFound || 0} inputs, ${data.inspectionSummary?.buttonsFound || 0} buttons`, "info");
  };

  const handleStatus = async () => {
    const data = await callApi({ action: "status" });
    if (data.error) {
      addLog(`Error: ${data.error}`, "error");
      return;
    }
    setBrowserActive(data.active);
    if (data.pageInfo) {
      setPageUrl(data.pageInfo.url || "");
      setPageTitle(data.pageInfo.title || "");
    }
    setNavHistory(data.navigationHistory || []);
    addLog(`Browser ${data.active ? "active" : "inactive"} - ${data.pageInfo?.url || "no page"}`, data.active ? "success" : "warn");
  };

  const handleClose = async () => {
    addLog("Closing browser...", "action");
    const data = await callApi({ action: "close" });
    if (data.error) {
      addLog(`Error: ${data.error}`, "error");
      return;
    }
    setBrowserActive(false);
    setInspectionData(null);
    setGeneratedConfig(null);
    setPageUrl("");
    setPageTitle("");
    setStatus("Browser closed");
    addLog("Browser closed", "info");
  };

  const handleExecute = async () => {
    if (!customCode.trim()) return;
    addLog("Executing custom script...", "action");
    const data = await callApi({ action: "execute", script: customCode.trim() });
    if (data.error) {
      addLog(`Error: ${data.error}`, "error");
      return;
    }
    addLog(`Result: ${JSON.stringify(data.result).slice(0, 500)}`, "success");
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text).then(() => {
      addLog("Copied to clipboard", "info");
    });
  };

  // Render inspection section based on active tab
  const renderInspectionTab = () => {
    if (!inspectionData) return <p className="text-gray-400 italic">No inspection data yet. Launch a browser and inspect.</p>;

    switch (activeTab) {
      case "inputs":
        return (
          <div className="space-y-1">
            <h3 className="font-bold text-blue-400 mb-2">Input Fields ({inspectionData.inputs?.length || 0})</h3>
            {inspectionData.inputs?.length === 0 && <p className="text-gray-400 italic">No inputs found</p>}
            {inspectionData.inputs?.map((input, i) => (
              <div key={i} className="bg-gray-700 p-2 rounded text-xs font-mono">
                <div className="text-yellow-300">{input.tag}{input.type ? `[type="${input.type}"]` : ""}</div>
                <div className="text-gray-300">
                  {input.id && <span className="mr-2">id: <span className="text-green-300">#{input.id}</span></span>}
                  {input.name && <span className="mr-2">name: <span className="text-green-300">{input.name}</span></span>}
                  {input.placeholder && <span className="mr-2">placeholder: <span className="text-green-300">"{input.placeholder}"</span></span>}
                  {input.autocomplete && <span className="mr-2">autocomplete: <span className="text-green-300">{input.autocomplete}</span></span>}
                  {input['aria-label'] && <span className="mr-2">aria-label: <span className="text-green-300">"{input['aria-label']}"</span></span>}
                  {input['data-testid'] && <span className="mr-2">data-testid: <span className="text-green-300">{input['data-testid']}</span></span>}
                </div>
                <div className="text-gray-400">
                  Visible: {input.visible ? "✅" : "❌"} | Position: ({Math.round(input.rect?.x || 0)}, {Math.round(input.rect?.y || 0)}) | Size: {Math.round(input.rect?.w || 0)}x{Math.round(input.rect?.h || 0)}
                </div>
                {input.parentText && <div className="text-purple-300">Parent label: "{input.parentText}"</div>}
              </div>
            ))}
          </div>
        );

      case "buttons":
        return (
          <div className="space-y-1">
            <h3 className="font-bold text-blue-400 mb-2">Buttons ({inspectionData.buttons?.length || 0})</h3>
            {inspectionData.buttons?.length === 0 && <p className="text-gray-400 italic">No buttons found</p>}
            {inspectionData.buttons?.map((btn, i) => (
              <div key={i} className="bg-gray-700 p-2 rounded text-xs font-mono">
                <div className="text-yellow-300">{'<'}{btn.tag}{'>'} "{btn.text}"</div>
                <div className="text-gray-300">
                  {btn.id && <span className="mr-2">id: <span className="text-green-300">#{btn.id}</span></span>}
                  {btn['data-testid'] && <span className="mr-2">data-testid: <span className="text-green-300">{btn['data-testid']}</span></span>}
                  {btn['aria-label'] && <span className="mr-2">aria-label: <span className="text-green-300">"{btn['aria-label']}"</span></span>}
                </div>
                <div className="text-gray-400">
                  Visible: {btn.visible ? "✅" : "❌"} | {btn.rect}
                </div>
              </div>
            ))}
          </div>
        );

      case "errors":
        return (
          <div className="space-y-1">
            <h3 className="font-bold text-red-400 mb-2">Error Messages ({inspectionData.errorMessages?.length || 0})</h3>
            {inspectionData.errorMessages?.length === 0 && <p className="text-gray-400 italic">No error messages detected</p>}
            {inspectionData.errorMessages?.map((err, i) => (
              <div key={i} className="bg-gray-700 p-2 rounded text-xs font-mono border-l-4 border-red-500">
                <div className="text-red-300">{err.text}</div>
                <div className="text-gray-400">{err.selector} {err.visible ? "✅" : "❌"}</div>
              </div>
            ))}
          </div>
        );

      case "verification":
        return (
          <div className="space-y-1">
            <h3 className="font-bold text-purple-400 mb-2">Verification / 2FA Elements ({inspectionData.verificationElements?.length || 0})</h3>
            {inspectionData.verificationElements?.length === 0 && <p className="text-gray-400 italic">No verification elements detected</p>}
            {inspectionData.verificationElements?.map((v, i) => (
              <div key={i} className="bg-gray-700 p-2 rounded text-xs font-mono border-l-4 border-purple-500">
                <div className="text-purple-300">Type: {v.type}</div>
                {v.placeholder && <div>placeholder: "{v.placeholder}"</div>}
                {v['aria-label'] && <div>aria-label: "{v['aria-label']}"</div>}
                {v.id && <div>id: #{v.id}</div>}
                {v.autocomplete && <div>autocomplete: {v.autocomplete}</div>}
                {v.text && <div>text: "{v.text}"</div>}
                {v.parentText && <div className="text-gray-400">context: "{v.parentText}"</div>}
              </div>
            ))}
          </div>
        );

      case "headings":
        return (
          <div className="space-y-1">
            <h3 className="font-bold text-blue-400 mb-2">Headings / Page Titles ({inspectionData.headings?.length || 0})</h3>
            {inspectionData.headings?.length === 0 && <p className="text-gray-400 italic">No headings found</p>}
            {inspectionData.headings?.map((h, i) => (
              <div key={i} className={`bg-gray-700 p-2 rounded text-xs font-mono ${h.tag === 'h1' ? 'border-l-4 border-yellow-500' : ''}`}>
                <span className="text-yellow-300">{'<'}{h.tag}{'>'}</span> {h.text}
              </div>
            ))}
          </div>
        );

      case "cookies":
        return (
          <div className="space-y-1">
            <h3 className="font-bold text-green-400 mb-2">Cookie Banners ({inspectionData.cookieBanners?.length || 0})</h3>
            {inspectionData.cookieBanners?.length === 0 && <p className="text-gray-400 italic">No cookie banners detected</p>}
            {inspectionData.cookieBanners?.map((b, i) => (
              <div key={i} className="bg-gray-700 p-2 rounded text-xs font-mono border-l-4 border-green-500">
                <div className="text-gray-300">"{b.text}"</div>
                <div className="text-green-300">Buttons: {b.buttons?.join(", ") || "none"}</div>
              </div>
            ))}
          </div>
        );

      case "forms":
        return (
          <div className="space-y-1">
            <h3 className="font-bold text-blue-400 mb-2">Forms ({inspectionData.forms?.length || 0})</h3>
            {inspectionData.forms?.length === 0 && <p className="text-gray-400 italic">No forms found</p>}
            {inspectionData.forms?.map((f, i) => (
              <div key={i} className="bg-gray-700 p-2 rounded text-xs font-mono">
                <div>Form #{f.index} {f.id ? `(id: #${f.id})` : ""}</div>
                <div className="text-gray-400">action: {f.action || "(none)"}</div>
                <div className="text-gray-400">fields: [{f.fields?.join(", ") || "none"}]</div>
              </div>
            ))}
          </div>
        );

      case "raw":
        return (
          <div className="space-y-1">
            <h3 className="font-bold text-gray-400 mb-2">Raw Inspection Data</h3>
            <button
              onClick={() => copyToClipboard(JSON.stringify(inspectionData, null, 2))}
              className="bg-gray-600 px-2 py-1 rounded text-xs mb-2 hover:bg-gray-500"
            >
              Copy Raw JSON
            </button>
            <pre className="bg-gray-900 p-2 rounded text-xs overflow-auto max-h-96 text-gray-300">
              {JSON.stringify(inspectionData, null, 2).slice(0, 10000)}
            </pre>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4 font-mono">
      <h1 className="text-2xl font-bold mb-4 text-blue-400">🔍 Login Inspector</h1>
      <p className="text-gray-400 text-sm mb-6">
        Launch a browser, manually interact with the login page, and inspect elements to build platform configs.
      </p>

      {/* Control Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        {/* Left: Controls */}
        <div className="bg-gray-800 p-4 rounded-lg">
          <h2 className="text-lg font-bold mb-3">Controls</h2>

          <div className="mb-3">
            <label className="text-xs text-gray-400 block mb-1">Session ID</label>
            <input
              type="text"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              className="w-full bg-gray-700 rounded px-2 py-1 text-sm"
            />
          </div>

          <div className="mb-3">
            <label className="text-xs text-gray-400 block mb-1">Platform</label>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className="w-full bg-gray-700 rounded px-2 py-1 text-sm"
            >
              {platforms.map(p => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>

          {platform === "custom" && (
            <div className="mb-3">
              <label className="text-xs text-gray-400 block mb-1">Custom URL</label>
              <input
                type="text"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                placeholder="https://..."
                className="w-full bg-gray-700 rounded px-2 py-1 text-sm"
              />
            </div>
          )}

          <div className="flex flex-wrap gap-2 mb-3">
            <button
              onClick={handleLaunch}
              disabled={loading}
              className="bg-green-600 hover:bg-green-500 disabled:bg-gray-600 px-3 py-1.5 rounded text-sm font-bold"
            >
              {loading ? "..." : "🚀 Launch"}
            </button>
            <button
              onClick={handleInspect}
              disabled={loading || !browserActive}
              className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 px-3 py-1.5 rounded text-sm"
            >
              🔍 Inspect
            </button>
            <button
              onClick={handleSave}
              disabled={loading || !browserActive}
              className="bg-yellow-600 hover:bg-yellow-500 disabled:bg-gray-600 px-3 py-1.5 rounded text-sm"
            >
              💾 Save Config
            </button>
            <button
              onClick={handleStatus}
              disabled={loading}
              className="bg-gray-600 hover:bg-gray-500 disabled:bg-gray-700 px-3 py-1.5 rounded text-sm"
            >
              📊 Status
            </button>
            <button
              onClick={handleClose}
              disabled={loading || !browserActive}
              className="bg-red-600 hover:bg-red-500 disabled:bg-gray-600 px-3 py-1.5 rounded text-sm"
            >
              ✖ Close
            </button>
          </div>

          {/* Status Bar */}
          <div className="bg-gray-900 p-2 rounded text-xs">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${browserActive ? 'bg-green-500' : 'bg-red-500'}`}></span>
              <span className="text-gray-300">{status}</span>
            </div>
            {pageUrl && <div className="text-gray-400 truncate mt-1">URL: {pageUrl}</div>}
            {pageTitle && <div className="text-gray-400 truncate">Title: {pageTitle}</div>}
          </div>
        </div>

        {/* Middle: Quick Actions */}
        <div className="bg-gray-800 p-4 rounded-lg">
          <h2 className="text-lg font-bold mb-3">Quick Navigation</h2>
          <div className="flex gap-2 mb-2">
            <input
              type="text"
              placeholder="Enter URL to navigate..."
              className="flex-1 bg-gray-700 rounded px-2 py-1 text-sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleNavigate(e.target.value);
              }}
            />
            <button
              onClick={() => {
                const input = document.querySelector('input[placeholder="Enter URL to navigate..."]');
                if (input) handleNavigate(input.value);
              }}
              disabled={!browserActive}
              className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 px-2 py-1 rounded text-sm"
            >
              Go
            </button>
          </div>

          <div className="mb-3">
            <label className="text-xs text-gray-400 block mb-1">Custom JavaScript (evaluate in page)</label>
            <textarea
              value={customCode}
              onChange={(e) => setCustomCode(e.target.value)}
              rows={3}
              className="w-full bg-gray-700 rounded px-2 py-1 text-xs font-mono"
              placeholder='e.g. document.querySelectorAll("button").length'
            />
            <button
              onClick={handleExecute}
              disabled={loading || !browserActive || !customCode.trim()}
              className="bg-purple-600 hover:bg-purple-500 disabled:bg-gray-600 px-2 py-1 rounded text-xs mt-1"
            >
              ▶ Execute
            </button>
          </div>

          {/* Navigation History */}
          {navHistory.length > 0 && (
            <div>
              <label className="text-xs text-gray-400 block mb-1">Navigation History</label>
              <div className="max-h-24 overflow-y-auto space-y-1">
                {navHistory.slice(-10).map((entry, i) => (
                  <div key={i} className="text-xs text-gray-400 truncate">
                    <button
                      onClick={() => handleNavigate(entry.url)}
                      className="text-blue-400 hover:underline"
                    >
                      {entry.url}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: Log */}
        <div className="bg-gray-800 p-4 rounded-lg">
          <h2 className="text-lg font-bold mb-3">Activity Log</h2>
          <div
            ref={logRef}
            className="bg-gray-900 p-2 rounded text-xs h-48 overflow-y-auto space-y-1"
          >
            {log.length === 0 && <p className="text-gray-500 italic">No activity yet</p>}
            {log.map((entry, i) => (
              <div key={i} className={`${
                entry.type === 'error' ? 'text-red-400' :
                entry.type === 'success' ? 'text-green-400' :
                entry.type === 'action' ? 'text-yellow-400' :
                entry.type === 'warn' ? 'text-orange-400' :
                'text-gray-300'
              }`}>
                <span className="text-gray-500">[{entry.timestamp}]</span> {entry.message}
              </div>
            ))}
          </div>
          <button
            onClick={() => setLog([])}
            className="text-xs text-gray-500 hover:text-gray-300 mt-1"
          >
            Clear log
          </button>
        </div>
      </div>

      {/* Main Content: Inspection Data + Generated Config */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Left: Inspection Results */}
        <div className="bg-gray-800 p-4 rounded-lg">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold">📋 Inspection Results</h2>
            <div className="flex gap-1 flex-wrap">
              {["inputs", "buttons", "headings", "errors", "verification", "cookies", "forms", "raw"].map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-2 py-0.5 rounded text-xs ${
                    activeTab === tab ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'
                  }`}
                >
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="bg-gray-900 p-3 rounded h-96 overflow-y-auto">
            {renderInspectionTab()}
          </div>
        </div>

        {/* Right: Generated Config */}
        <div className="bg-gray-800 p-4 rounded-lg">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold">⚙️ Generated Platform Config</h2>
            {generatedConfig && (
              <button
                onClick={() => copyToClipboard(JSON.stringify(generatedConfig, null, 2))}
                className="bg-gray-600 hover:bg-gray-500 px-2 py-0.5 rounded text-xs"
              >
                Copy Config
              </button>
            )}
          </div>
          <div className="bg-gray-900 p-3 rounded h-96 overflow-y-auto">
            {!generatedConfig ? (
              <p className="text-gray-400 italic">
                1. Launch a browser for a platform<br />
                2. Go through login scenarios manually<br />
                3. Click "Inspect" at each step<br />
                4. Click "Save Config" to generate the platform config
              </p>
            ) : (
              <pre className="text-xs text-green-300 overflow-x-auto">
                {JSON.stringify(generatedConfig, null, 2)}
              </pre>
            )}
            {generatedConfig && (
              <div className="mt-3 bg-gray-700 p-3 rounded">
                <h3 className="text-sm font-bold text-yellow-300 mb-2">How to use this config</h3>
                <p className="text-xs text-gray-300">
                  1. Copy the JSON above<br />
                  2. Add it to <code className="text-green-300">src/app/socials/cookie/cookie-api-login/platforms.js</code><br />
                  3. Register it in the platformConfigs object<br />
                  4. Add MX keywords for auto-detection if needed
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Scenario Guide */}
      <div className="bg-gray-800 p-4 rounded-lg mt-4">
        <h2 className="text-lg font-bold mb-3">📝 Login Scenario Guide</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div className="bg-gray-900 p-3 rounded border-l-4 border-yellow-500">
            <h3 className="font-bold text-yellow-300 mb-1">1. Initial Load</h3>
            <p>Launch → Inspect. Captures email/username input, next button, cookie banners.</p>
          </div>
          <div className="bg-gray-900 p-3 rounded border-l-4 border-orange-500">
            <h3 className="font-bold text-orange-300 mb-1">2. Wrong Email</h3>
            <p>Type invalid email → click next → Inspect. Captures error selectors.</p>
          </div>
          <div className="bg-gray-900 p-3 rounded border-l-4 border-blue-500">
            <h3 className="font-bold text-blue-300 mb-1">3. Correct Email → Wrong Password</h3>
            <p>Valid email → wrong password → Inspect. Captures password error selectors.</p>
          </div>
          <div className="bg-gray-900 p-3 rounded border-l-4 border-green-500">
            <h3 className="font-bold text-green-300 mb-1">4. Correct Login</h3>
            <p>Valid email + password → Inspect. Captures inbox URL patterns.</p>
          </div>
          <div className="bg-gray-900 p-3 rounded border-l-4 border-purple-500">
            <h3 className="font-bold text-purple-300 mb-1">5. 2FA Verification</h3>
            <p>If 2FA appears → Inspect. Captures code input, choice options, submit buttons.</p>
          </div>
          <div className="bg-gray-900 p-3 rounded border-l-4 border-red-500">
            <h3 className="font-bold text-red-300 mb-1">6. Inbox Reached</h3>
            <p>After login/2FA → Inspect. Captures inbox URL, logged-in state selectors.</p>
          </div>
        </div>
      </div>
    </div>
  );
}