const moment = require('moment');
const Bottleneck = require('bottleneck');

const logger = require('@lib/logger').scope('import');
const candles = require('@lib/coinbase/endpoints/products/candles');
const { client: sqlite } = require('@lib/database/sqlite');

module.exports.isoFormat = 'YYYY-MM-DDTHH:mm';

module.exports.maxDataPointsPerRequest = 300;

module.exports.availableGranularity = [60, 300, 900, 3600, 21600, 86400];

module.exports.generateDates = (start, granularity) => ({
  startDate: moment(start).format(this.isoFormat),
  endDate: moment(start).subtract(this.maxDataPointsPerRequest * granularity, 'seconds').format(this.isoFormat),
});

module.exports.checkOrCreateTables = () => {
  const createImportsQuery = `
    CREATE TABLE IF NOT EXISTS imports
    (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE,
      product TEXT,
      datapoints INTEGER,
      granularity INTEGER,
      timestamp INTEGER
    );
  `;
  const createCandlesQuery = `
    CREATE TABLE IF NOT EXISTS candles
    (
      id INTEGER PRIMARY KEY,
      importId INTEGER NOT NULL,
      product TEXT,
      timestamp INTEGER,
      low INTEGER,
      high INTEGER,
      open INTEGER,
      close INTEGER,
      volume INTEGER
    );
  `;

  return Promise.all([
    new Promise((resolve, reject) => {
      sqlite.run(createImportsQuery, (err) => {
        if (err) return reject();
        return resolve();
      });
    }),
    new Promise((resolve, reject) => {
      sqlite.run(createCandlesQuery, (err) => {
        if (err) return reject();
        return resolve();
      });
    }),
  ]);
};

const limiter = new Bottleneck({
  reservoir: 30, // initial value
  reservoirIncreaseMaximum: 30,
  reservoirRefreshAmount: 100,
  reservoirRefreshInterval: 30 * 1000, // must be divisible by 250

  // also use maxConcurrent and/or minTime for safety
  maxConcurrent: 1,
  minTime: 1000,
});

module.exports.addRanges = (ranges, product, granularity, importId) => {
  ranges.forEach(({ endDate, startDate }) => limiter.schedule(() => {
    logger.info(`Current job count: ${limiter.counts().QUEUED}`);
    logger.info(`Added range ${endDate} - ${startDate}`);

    return this.fetchCandlesAndSave(product, endDate, startDate, granularity, importId);
  }));
};

module.exports.fetchCandlesAndSave = (product, start, end, granularity, importId) => {
  candles.get(product, start, end, granularity)
    .then(({ data }) => {
      logger.info('New data received');
      const prepared = sqlite.prepare(`
        INSERT INTO candles
        (importId, product, timestamp, low, high, open, close, volume)
        VALUES
        (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const dbJobs = data.map(async (candle) => prepared.run([importId, product, ...candle]));

      return Promise.all(dbJobs).finally(() => {
        logger.info('New data saved to database');
      });
    })
    .catch((error) => {
      logger.info('Importing data failed');
      if (error.response) {
        if (error.response.status === 400) {
          const divideBy = 2;
          logger.info(`Granularity too large for start and end date. Divide by ${divideBy}`);
          const ranges = [];
          let dates = {};
          for (let i = 0; i < divideBy; i += 1) {
            const dateToAdd = i === 0 ? start : dates.endDate;
            dates = this.generateDates(dateToAdd, granularity / divideBy);
            ranges.push(dates);
          }
          this.addRanges(ranges, product, granularity, importId);
        } else if (error.response.status === 404) {
          logger.error('Couldn\'t be found. Please make sure you add an available product');
          throw new Error(error.response.data);
        }
      } else {
        limiter.schedule(() => this.fetchCandlesAndSave(product, end, start, granularity));
      }
    });
};

module.exports.createImport = (name, product, datapoints, granularity, timestamp) => {
  const query = `
  INSERT INTO imports
  (name, product, datapoints, granularity, timestamp)
  VALUES
  (?, ?, ?, ?, ?);
  `;
  return new Promise((resolve, reject) => {
    sqlite.run(query, [name, product, datapoints, granularity, timestamp], function returnId(error) {
      if (error) return reject(error);
      return resolve(this.lastID);
    });
  });
};

module.exports = async (args) => {
  logger.info('Starting import');
  // Check if the candles table exists
  await this.checkOrCreateTables();

  const granularity = () => {
    if (args.granularity) {
      if (this.availableGranularity.includes(args.granularity)) {
        return args.granularity;
      }
      logger.error(`Granularity must be one of: ${this.availableGranularity.join(', ')}`);
      return false;
    }
    return 60;
  };

  const datapoints = () => {
    if (args.datapoints) {
      const type = typeof args.datapoints;
      if (type === 'number') {
        return args.datapoints;
      }
      logger.error(`Datapoints must be of type number. ${type} given`);
      return false;
    }
    return 9000;
  };

  const product = () => {
    if (args.product) {
      return args.product;
    }
    return 'BTC-EUR';
  };

  const name = () => {
    if (args.name) {
      const type = typeof args.name;
      if (type === 'string') {
        return args.name;
      }
      logger.error(`Name must be of type string. ${type} given`);
    }
    return false;
  };

  if (!name()) {
    logger.error('No name specified for import');
    return;
  }

  if (!datapoints()) {
    logger.error('Datapoint invalid');
    return;
  }

  if (!granularity()) {
    logger.error('Granularity invalid');
    return;
  }

  this.createImport(name(), product(), datapoints(), granularity(), moment().unix())
    .then((importId) => {
      logger.info('Importing data from Coinbase');
      logger.info(`Import name: ${name()}`);
      logger.info(`Import id: ${importId}`);
      logger.info(`Product: ${product()}`);
      logger.info(`Granularity: ${granularity()} seconds`);
      logger.info(`Total datapoints: ${datapoints()}`);
      logger.info(`Total requests: ${datapoints() / this.maxDataPointsPerRequest}`);

      const ranges = [];
      let dates = {};
      for (let i = 0; i < datapoints(); i += this.maxDataPointsPerRequest) {
        const dateToAdd = i === 0 ? moment(new Date()).subtract(1, 'day') : dates.endDate;
        dates = this.generateDates(dateToAdd, granularity());
        ranges.push(dates);
      }

      this.addRanges(ranges, product(), granularity(), importId);
    })
    .catch((error) => {
      logger.error('Import could not be done. Import name probably already exists.');
      logger.error(error);
    });

  limiter.on('empty', () => {
    logger.info('Empty queue. Exit.');
    process.exit();
  });
};
