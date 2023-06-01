import * as core from '@actions/core';

function _outputCI(name: string, value: string) {
	core.setOutput(name, value);
}

export const outputCI = ((): (name: string, value: string) => void => {
	if (!process.env.CI) {
		return () => { };
	}
	return _outputCI;
})();
