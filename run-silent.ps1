$env:Path = 'C:\Program Files\nodejs;' + $env:Path
$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm.cmd run prod:silent -- --port 3001
