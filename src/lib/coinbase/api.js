const axios = require('axios');
const auth = require('@lib/coinbase/auth');
const logger = require('@lib/logger');

// Get the coinbase api url from the env
const {
  COINBASE_API_URL,
} = process.env;

// Create an new Axios client
const client = axios.create({
  baseURL: COINBASE_API_URL,
  timeout: 1000,
  headers: {
    'Content-type': 'application/json',
    Accept: 'application/json',
    'Accept-Charset': 'utf-8',
    'User-Agent': 'CPTB Client',
  },
  json: true,
});

// Add response interceptors for the client
client.interceptors.response.use(
  // Responses should always resolve without interference
  (response) => Promise.resolve(response),
  // Errors should always reject after being logged
  (error) => {
    logger.error(error.response.data);
    logger.error(error.response.status);
    return Promise.reject(error);
  },
);

/**
 * Create the options to be passed with the request
 * @param {boolean} requriresAuth - Should the request be authenticated
 * @param {string} method - One of [delete, post, patch, put, get]
 * @param {string} path - Which path to request
 * @param {Object|string} body - The request body
 * @returns {Object}
 */
const options = async (requiresAuth, method, path, body = '') => {
  if (requiresAuth) {
    const headers = await auth.generateAuthHeaders(method, path, body);
    return { headers };
  }
  return {};
};

/**
 * Do a get request to the Coinbase api
 * @param {string} path - The path the request should go to
 * @param {boolean} requriresAuth - Should the request be authenticated
 * @returns {Object}
 */
module.exports.getRequest = async (path, requiresAuth = true) => {
  const requestOptions = await options(requiresAuth, 'GET', path);

  const { data, status } = (await client.get(path, requestOptions));

  if (status !== 200) {
    logger.error('Request failed');
  }

  return data;
};
