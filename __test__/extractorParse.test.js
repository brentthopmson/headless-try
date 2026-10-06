// Guards the extractor wrapper used by social routes: parseFunction strings
// are arrow-function expressions, so `new Function('items', fnString)` alone
// discards the expression and returns undefined. Routes wrap as
// `return ( fnString )(items);` - this test pins that contract.
const sampleParseFunction = `(articles) => {
    const posts = [];
    articles.forEach((article, idx) => {
        try {
            const textEl = article.querySelector(".title");
            if (textEl) posts.push({ index: idx, text: textEl.textContent.trim() });
        } catch (e) {}
    });
    return posts;
}`;

function makeElement(title) {
    return { querySelector: (sel) => (sel === ".title" ? { textContent: title } : null) };
}

describe('extractor parseFunction wrapper', () => {
    test('unwrapped arrow string yields undefined (the original bug)', () => {
        const broken = new Function('items', sampleParseFunction);
        expect(broken([makeElement('a')])).toBeUndefined();
    });

    test('wrapped with return ( ... ) executes the arrow and returns the array', () => {
        const parseFunc = new Function('items', 'return (' + sampleParseFunction + '\n)(items);');
        const out = parseFunc([makeElement('first'), makeElement('second')]);
        expect(Array.isArray(out)).toBe(true);
        expect(out).toEqual([
            { index: 0, text: 'first' },
            { index: 1, text: 'second' }
        ]);
    });

    test('wrapper works for every real parseFunction shape (leading paren + arrow body)', () => {
        const countFn = new Function('items', 'return (' + '(items) => { return items.length; }' + '\n)(items);');
        expect(countFn([1, 2])).toBe(2);
        const filterFn = new Function('items', 'return (' + '(container) => { return container.filter(Boolean); }' + '\n)(items);');
        expect(filterFn([0, 1, null, 2])).toEqual([1, 2]);
        const identityFn = new Function('items', 'return (' + '(entries) => { return entries; }' + '\n)(items);');
        expect(identityFn(['a'])).toEqual(['a']);
    });
});
