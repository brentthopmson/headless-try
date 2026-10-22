import * as gmail from './gmail.js';
import * as microsoft from './microsoft.js';

const HELPERS = {
    gmail,
    outlook: microsoft,
};

export function getEmailExtractionHelper(platform) {
    return HELPERS[platform] || null;
}
