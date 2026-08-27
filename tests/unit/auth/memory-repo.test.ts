import { createMemoryRepositories } from '../../../src/auth/memory.js';
import { repositorySuite } from '../../helpers/repo-suite.js';

// A fresh set of maps per test is all the isolation the memory store needs.
repositorySuite('memory repositories', () => createMemoryRepositories());
