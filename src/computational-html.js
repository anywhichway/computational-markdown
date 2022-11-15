import replaceAsync from "https://cdn.jsdelivr.net/npm/string-replace-async@3.0.2";
import XRegExp from "https://esm.sh/xregexp@5.1.1?bundle";
import JSON5 from "https://esm.sh/json5@2.2.1?bundle";
import QuickWorker from "https://esm.sh/@anywhichway/quick-worker@0.0.2?bundle";

const sanitize = async (text) => {
    if(!sanitize.evaluator) {
        sanitize.evaluator = await QuickWorker({
            timeout: 1000,
            properties: {
                sanitize: async (text) => {
                    const sanitizeHtml = self.sanitizeHtml ||= (await import('https://esm.sh/sanitize-html@2.7.3')).default;
                    return sanitizeHtml(text);
                }
            }
        });
    }
    const f = (await sanitize.evaluator.sanitize);
   return f(text);
}
const replaceReferences = async (string,requestor) => {
    for(const match of XRegExp.matchRecursive(string, '\\!\\[', '\\]', 'g',{unbalanced:"skip"})) {
        string = await replaceAsync(string,new RegExp(`\\!\\[(${XRegExp.escape(match)})\\]`,"g"),async (match,selector) => {
            let bracketAdded;
            if(selector.endsWith("[")) {
                selector += "]";
                bracketAdded = true;
            }
            try {
                const value = selector==="document.data" ? {...document.data||{}} : await valueOf(selector,requestor),
                    type = typeof(value);
                if(type==="string") {
                    return "`" + value + "`";
                }
                if(value && type==="object") {
                    if(selector==="document.data") {
                        delete value.urls; // really big and should not need in worker
                    }
                    const text = JSON.stringify(value);
                    if(bracketAdded && text.endsWith("]")) { // a HACK because matchRecursive drops the last "]"
                        return text.substring(0,text.length-1);
                    }
                    return text;
                }
                return value;
            } catch(e) {
                return match;
            }
        })
    }
    return string;
}
const stringTemplateLiteralEval = async (stringTemplateLiteral,requestor) => {
        if(!stringTemplateLiteralEval.evaluator) {
            stringTemplateLiteralEval.evaluator = await QuickWorker({
                properties: {
                    document: {
                        data: Object.entries(document.data).reduce((data, [key, value]) => {
                            if (key !== "urls") {
                                data[key] = value;
                            }
                            return data;
                        }, {})
                    },
                    evaluate: async (stringTemplateLiteral) => {
                        const ul = (data = {}, format = (data) => data && typeof (data) === "object" ? JSON.stringify(data) : data) => {
                                return "<ul>" + Object.values(data).reduce((items,item) => items += ("<li>" + format(item) + "</li>\n"),"") + "</ul>"
                            },
                            ol = (data = {}, format = (data) => data && typeof (data) === "object" ? JSON.stringify(data) : data) => {
                                return "<ol>" + Object.values(data).reduce((items,item) => items += ("<li>" + format(item) + "</li>\n"),"") + "</ol>"
                            },
                            solve = (formula, args) => {
                                formula = formula+"";// MathJS sends in an object that stringifies to the forumla
                                Object.entries(args).forEach(([variable, value]) => {
                                    formula = formula.replaceAll(new RegExp(variable, "g"), value);
                                })
                                return new Function("return " + formula)();
                            },
                            functions = {
                                ul,
                                ol,
                                solve
                            }
                        try {
                            return await (new Function("functions", "math", "globalThis", "with(functions) { with(math) { return `" + stringTemplateLiteral + "`}}")).call(null, functions, self.math); //always 2 args so globalThis is undefined
                        } catch (e) {
                            return {stringTemplateLiteralError: e + ""}
                        }
                    },
                },
                timeout:1000,
                imports:['https://cdn.jsdelivr.net/npm/mathjs@11.3.2/lib/browser/math.min.js']})
        }
        const original = stringTemplateLiteral;
        stringTemplateLiteral = await replaceReferences(stringTemplateLiteral,requestor);
        if(stringTemplateLiteral!==original && XRegExp.matchRecursive(stringTemplateLiteral, '\\!\\[', '\\]', 'g',{unbalanced:"skip"}).length>0) {
            const message = `Error processing ${original}. Check for loop in dependencies.`;
            console.error(new EvalError(message));
            requestor.classList.add("chtml-error");
            return `${message}`
        } else {
            return (await stringTemplateLiteralEval.evaluator.evaluate)(stringTemplateLiteral);
        }
    },
    AsyncFunction = (async () => {}).constructor,
    NODESTACK = new Set(),
    EVALUATOR = new XPathEvaluator(),
    validateSelector = ((dummyElement) =>
        (selector) => {
            try {
                dummyElement.querySelector(selector)
            } catch {
                try {
                    EVALUATOR.createExpression(selector);
                    return {type: "xpath", selector};
                } catch {

                }
            }
            return {type: "css", selector};
        })(document.createDocumentFragment()),
    coerce = (value) => {
        if(typeof(value)==="object") {
            return value;
        }
        try {
            return JSON5.parse(value); // succeeds for true, false, objects, and numbers
        } catch (e) {
            const asString = value+"";
            if(asString==="Infinity") return Infinity;
            if(asString==="-Infinity") return -Infinity;
            if(asString==="NaN") return NaN;
            if(asString==="undefined") return undefined;
            return '"' + value + '"';
        }
    },
    interpolate = async (node) => {
        NODESTACK.add(node);
        if (node.hasAttribute("data-string-template") &&  !(["INPUT","SELECT","TEXTAREA","IMG","BR","HR"].includes(node.tagName))) {
            //const scope = node.tagName === "SPAN" ? node.parentElement : node;
            const string = node.getAttribute("data-string-template");
            if(string) {
                 let value = await stringTemplateLiteralEval(string,node);
                 const type = typeof(value);
                if(type==="string") {
                    value = await sanitize(value);
                } else if(value && type==="object") {
                    value = JSON.stringify(value);
                }
                if(node.innerHTML!==value+"") {
                    node.innerHTML = value;
                }
            }
        }
    },
    valueOf = async function (arg,requestor) {
        const {selector, type} = validateSelector(arg) || {};
        if (!selector) {
            throw new TypeError(arg + " is mot a valid CSS or XPath selector")
        }
        const values = [],
            isArray = arg.endsWith("[]");
        let els;
        arg = isArray ? arg.substring(0, arg.length - 2) : arg;
        if (type === "css") {
            if (isArray) {
                els = [...document.querySelectorAll(arg) || []]
            } else {
                const el = document.querySelector(arg)
                els = el ? [el] : [];
            }
        } else if (type === "xpath") {
            const expression = EVALUATOR.createExpression(arg),
                result = expression.evaluate(document, XPathResult.ORDERED_NODE_ITERATOR_TYPE)
            els = [];
            let el;
            while (el = result.iterateNext()) {
                els.push(el);
            }
        }
        for (const el of els) {
            let string;
            if(["INPUT","SELECT","TEXTAREA"].includes(el.tagName)) {
                string = el.value;
                if(string==="") {
                    string = coerce(el.getAttribute("data-default")|| node.getAttribute("default")||"")
                }
            } else {
                string = el.textContent;
                if(string==="") {
                    string = coerce(node.getAttribute("data-default")|| node.getAttribute("default")||"");
                } else {
                    await process(el);
                    string = el.textContent
                }
            }
            values.push(coerce(string));
        }
        return isArray ? values : values[0]
    },
    process = async (node) => {
        if (["IMG","BR","HR","INPUT","SELECT","TEXTAREA","LINK","META","AUDIO","VIDEO"].includes(node.tagName) || node.classList.contains("ne-error")) {
            return;
        }
        let string = node.innerHTML || node.textContent;
        if (NODESTACK.has(node)) return string;
        else NODESTACK.add(node);
        const src = node.nodeType === Node.ELEMENT_NODE ? node.getAttribute("src") : null;
        if (src) {
            if (src[0] === "#") {
                const source = document.getElementById(src.substring(1));
                await process(source);
                string = source.innerHTML || await sanitize(source.textContent);
            } else if (src.startsWith("${")) {
                const value = await stringTemplateLiteralEval(src,node),
                    type = typeof(value);
                if(type==="string") {
                    string = await sanitize(value);
                } else if(value && type==="object") {
                    string = JSON.stringify(value);
                } else {
                    string = value;
                }
            } else {
                try {
                    const url = new URL(src, document.baseURI),
                        response = await (node.request ||= fetch(url.href));
                    if(response.status===200) {
                        try {
                            string = await response.text();
                        } catch(e) {
                            // memoized request may have been read already, ignore errors
                        }
                        string = await sanitize(string);
                    } else {
                        node.innerHTML = `<span style="color:red" class="chtml-error">fetch("${url.href}") returned ${response.status}</span>`;
                        string = node.innerText;
                    }
                } catch (e) {
                    console.error(e);
                }
            }
            if(string && typeof(string)==="object") {
                string = JSON.stringify(string);
            }
            string = (string+"").replace(/\r\n/g,"\\n");
            if(node.innerHTML!==string) {
                node.innerHTML = string;
            }
            const parent = node.parentElement;
            await interpolate(node);
        } else if (node.hasAttribute("data-string-template")) {
            await interpolate(node);
        }
        if (node.isConnected) {
            for (const child of [...node.children]) {
               // if(!child.classList.contains("ne-error")) {
                    await process(child);
               //}
            }
        }
    };
    const attach = async (target) => {
        document.data && typeof(document.data)==="object" || (document.data = JSON.parse(target.querySelector("#document-data")?.textContent || "{}"));
        [...document.querySelectorAll('img[src^="#"]')].forEach((img) => {
            const id = img.getAttribute("src").substring(1),
                url = document.data.urls[id];
            if(url) {
                img.setAttribute("src",url);
            }
        })
        if(!target.observer) {
            target.observer = new MutationObserver(async (mutationList) => {
                for (const mutation of mutationList) {
                    if (mutation.type === 'childList' || mutation.type==='characterData') {
                        const target = mutation.target;
                        if(!target.classList.contains("chtml-error")  && !["AUDIO","VIDEO"].includes(target.tagName)) {
                            if(!NODESTACK.has(target)) {
                                await process(target);
                            }
                            for(let i=0;i<mutation.addedNodes.length;i++) {
                                let node = mutation.addedNodes[i];
                                if(mutation.addedNodes.length===mutation.removedNodes.length && node.textContent===mutation.removedNodes[i].textContent) {
                                    continue;
                                }
                                if(node.nodeType===Node.TEXT_NODE) {
                                    node = node.parentElement;
                                }
                                if(!node.classList.contains("chtml-error") && !["AUDIO","VIDEO"].includes(node.tagName)) {
                                    await process(node);
                                }
                            }
                        }
                    }
                }
                NODESTACK.clear();
            });
            target.observer.observe(target, {
                //attributes: true,
                childList: true,
                subtree: true//,
                //characterData: true
            });
            target.addEventListener("change",async () => {
                NODESTACK.clear();
                await process(target);
            })
            target.addEventListener("input",async () => {
                NODESTACK.clear();
                await process(target);
            })
        }
        await process(target);
        NODESTACK.clear();
    };
export {attach,replaceReferences};
