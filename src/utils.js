const path = require('path');

const getMetadata = () => {
	try {
		const fn = require(path.resolve(process.cwd(), '.houston/metadata.js'));
		return fn;
	} catch (e) {
		//
	}
	return () => Promise.resolve({});
};

module.exports = {
	getMetadata
};
