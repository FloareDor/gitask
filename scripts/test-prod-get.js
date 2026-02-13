const https = require('https');

const options = {
	hostname: 'gitask2.vercel.app',
	port: 443,
	path: '/api/gemini',
	method: 'GET',
};

const req = https.request(options, (res) => {
	let body = '';
	res.on('data', (d) => {
		body += d;
	});
	res.on('end', () => {
		console.log('Status:', res.statusCode);
		console.log('Body:', body);
	});
});

req.on('error', (e) => {
	console.error(e);
});
req.end();
