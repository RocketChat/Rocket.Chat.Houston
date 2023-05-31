import { Command } from 'commander';
import { createBranch } from './commands/createBranch';

const program = new Command();

program.name('houston');

program
	.command('create-branch')
	.description('Create a new branch for a new release')
	.requiredOption('-b, --base <branch or version>', 'Base branch or version to create the new branch from')
	.requiredOption('-t, --type <patch|minor|major>', 'Type of release')
	.action(async function(str) {
		try {
			if (!['patch', 'minor', 'major'].includes(str.type)) {
				throw new Error('Invalid release type');
			}
			await createBranch({ base: str.base, type: str.type });
		} catch (error) {
			console.error(error);
			process.exit(1);
		}
	});

program.parse(process.argv);
