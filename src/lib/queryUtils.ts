export function shouldInjectBaselineContext(query: string): boolean {
	const normalized = query.toLowerCase();
	return (
		/\b(what does|what is|tell me about)\b.*\b(project|repo|repository)\b/.test(normalized) ||
		/\b(project|repo|repository)\b.*\b(overview|summary|purpose|about)\b/.test(normalized) ||
		/\b(main|key)\s+(entry\s+points?|components|modules|data\s+flow|architecture)\b/.test(normalized) ||
		/\b(high[-\s]?level|big picture)\b/.test(normalized)
	);
}

export function isFactSeekingQuery(query: string): boolean {
	const normalized = query.toLowerCase();
	return (
		/\b(hyperparameter|dropout|temperature|top[_\s-]?p|top[_\s-]?k|learning[_\s-]?rate|batch[_\s-]?size)\b/.test(normalized) ||
		/\b(default|exact|specific|numeric|number|value|values|setting|settings|config|configuration)\b/.test(normalized) ||
		/^\s*(how many|where)\b/.test(normalized)
	);
}
