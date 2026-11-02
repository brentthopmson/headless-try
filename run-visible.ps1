$env:Path = 'C:\Program Files\nodejs;' + $env:Path
$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:SHOW_BROWSER = 'true'
$env:BROWSER_VISIBLE = 'true'
$env:HEADLESS = 'false'
npm.cmd run prod:visible -- --port 3001
