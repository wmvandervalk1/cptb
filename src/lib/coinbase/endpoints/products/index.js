const api = require('@lib/coinbase/api');

/**
 * Get a list of available currency pairings
 * @returns {Promise}
 */
module.exports.get = () => api.getRequest('/products', true);
