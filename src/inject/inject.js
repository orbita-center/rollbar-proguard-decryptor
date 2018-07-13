let settings = null;

const initializeExtension = async () => {
	settings = await getSettings();

	if (!settings.apiToken) {
		console.warn('API token is not defined. You may set it in options.');
		return;
	}

	const { counter, occurenceId } = getIds(window.location.pathname);

	if (!counter) {
		return;
	}

	const occurence = occurenceId
		? await getOccurence(occurenceId)
		: await getItemByCounter(counter).then(item => getOccurence(item.last_occurrence_id));

	if (occurence.data.language !== 'java') {
		console.log('Language is not Java. Nothing to do.');
		return;
	}

	const decryptedTraceback = await decryptOccurence(occurence);

	renderTraceback(decryptedTraceback);
};

const getSettings = () => new Promise((resolve) => {
	const defaults = {
		apiToken: ''
	};
	chrome.storage.sync.get(defaults, resolve);
});

const renderTraceback = traces => {
	const container = $('.traceback');
	container.html('');
	traces.reverse().forEach(trace => {
		container.append(`
<div class="exception">
	<span class="exception-class">${trace.exception.class}</span>${trace.exception.message ? `: ${trace.exception.message}` : ''}
	<br>
</div>`);
		container.append(`
<div class="traceback-inner">
${trace.frames.reverse().map((frame, i) => `
	<div class="frame">
		<div class="gutter">
			${i + 1}
		</div>
		<div class="framedata">
		  	<div class="location">at <span class="filename">${frame.class_name}.${frame.method}</span>
				(<span class="filename">${frame.filename}:${frame.lineno}</span>)
		  </div>
		</div>
		<div style="clear:both;display:block;"></div>
	</div>
`).join('')}
</div>`);
	});
};

const getItemByCounter = counter => queryApi(`/item_by_counter/${counter}`);

const getOccurence = occurenceId => queryApi(`/instance/${occurenceId}`);

const decryptOccurence = occurence => {
	if (!occurence.data.code_version) {
		console.log('Code version is not defined in the occurence');
	}

	return getMapping(occurence.data.code_version)
		.then(mapping => {
			if (occurence.data.body.trace_chain) {
				return occurence.data.body.trace_chain.map(trace => decryptStacktrace(trace, mapping));
			} else {
				return [decryptStacktrace(occurence.data.body.trace, mapping)];
			}
		})
};

String.prototype.replaceAll = function(search, replacement) {
    return this.split(search).join(replacement);
};

const decryptStacktrace = (trace, mapping) => {
	const decryptClassname = (encryptedClassName) => mapping[encryptedClassName]
		? mapping[encryptedClassName].name
		: encryptedClassName;

	const decryptString = str => Object.keys(mapping)
		.sort((a, b) => b.length - a.length)
		.reduce((acc, key) => acc.replaceAll(key, mapping[key].name), str);

	const decryptException = exception => {
		if (typeof exception === 'object') {
			return {
				message: exception.message && decryptString(exception.message),
				class: decryptClassname(exception.class)
			}
		}
		return decryptClassname(exception);
	};

	const decryptMethod = (encryptedClassName, encryptedMethodName, lineno) => {
		const clazz = mapping[encryptedClassName];
		if (!clazz) return encryptedMethodName;
		const methods = clazz.methods.get(encryptedMethodName);
		if (!methods) return encryptedMethodName;
		const method =  methods.find(m => m.lineFrom && m.lineTo && lineno >= m.lineFrom && lineno <= m.lineTo)
			|| methods[0];
	
		return method.name;
	};

	return {
		exception: decryptException(trace.exception),
		frames: trace.frames.map(({ class_name, filename, lineno, method }) => ({
			class_name: decryptClassname(class_name),
			filename: filename === 'SourceFile'
				? decryptClassname(class_name).split('.').pop() + '.kt'
				: filename,
			lineno,
			method: decryptMethod(class_name, method, lineno)
		}))
	};
};

const getMapping = codeVersion => {
	const projectPath = location.pathname.split('/').slice(0, 3).join('/');
	return fetch(`https://rollbar.com${projectPath}/settings/proguard/`, { credentials: "same-origin" })
		.then(response => response.text())
		.then(html => $('<div></div>').append(jQuery.parseHTML(html)))
		.then(doc => doc
			.find(`td:contains("${codeVersion}")`)
			.siblings(':last')
			.find('form'))
		.then(form => ({
			path: form.attr('action'),
			query: form.serialize()
		}))
		.then(({ path, query }) => fetch(`${path}?${query}`, { credentials: "same-origin" }))
		.then(response => response.text())
		.then(parseMapping)
		.catch(e => {
			throw new Error(`Failed to load mapping for version ${codeVersion}`);
		});
}

const parseMapping = text => {
	return text
		.match(/^[^\s].*?:(\n\s+.*)*/gm)
		.map(classText => {
			const nameMapping = classText.match(/^([^\s]+)\s->\s(.+):/);
			const fieldRegex = RegExp(/^\s+\S*\s+([^\s()]*)\s+->\s+(\S*)/gm);
			const fields = new Map();
			while ((match = fieldRegex.exec(classText)) !== null) {
				fields.set(match[2], match[1]);
			}

			const methodRegex = RegExp(/^\s+((\d+):(\d+):)?\S*\s+(\S*)\([^)]*\)\s+->\s+(\S*)/gm);
			const methods = new Map();
			while ((match = methodRegex.exec(classText)) !== null) {
				const method = methods.get(match[5]) || [];
				method.push({
					name: match[4],
					lineFrom: match[2],
					lineTo: match[3]
				});
				methods.set(match[5], method);
			}

			return {
				original: nameMapping[1],
				encrypted: nameMapping[2],
				fields,
				methods
			};
		})
		.reduce((acc, clazz) => ({ ...acc, [clazz.encrypted]: { name: clazz.original, fields: clazz.fields, methods: clazz.methods } }), {});
};

const queryApi = (path) => {
	return fetch(`https://api.rollbar.com/api/1${path}?access_token=${settings.apiToken}`)
		.then(response => response.json())
		.then(response => {
			if (response.err === 0) {
				return response.result;
			}
			else {
				throw new Error(response.message);
			}
		});
}

const getIds = (url) => {
	const getIdFromMatch = (match) => match === null ? null : parseInt(match[1]);
	return { 
		counter: getIdFromMatch(url.match(/\/items\/(\d+)\//)),
		occurenceId: getIdFromMatch(url.match(/\/occurrences\/(\d+?)\//))
	};
}

chrome.extension.sendMessage({}, function(response) {
	var readyStateCheckInterval = setInterval(function() {
		if (document.readyState === "complete") {
			clearInterval(readyStateCheckInterval);
			initializeExtension();
		}
	}, 10);
});