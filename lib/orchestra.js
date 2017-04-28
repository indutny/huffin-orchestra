'use strict';

const assert = require('assert');
const async = require('async');
const fs = require('fs');
const request = require('request');
const prompt = require('prompt');
const huffin = require('huffin');
const DigitalOcean = require('do-wrapper');

const utils = require('./utils');

const TARGET_PROBABILITY = 0.95;

prompt.start();

function Orchestra(options) {
  this.ocean = new DigitalOcean(options.token);
  this.cert = fs.readFileSync(options.cert);
  this.port = options.port;
  this.username = options.username;
  this.passphrase = options.passphrase;
}
module.exports = Orchestra;

Orchestra.prototype.run = function run(command, options) {
  if (command === 'spawn')
    return this._runSpawn(options);
  else if (command === 'destroy')
    return this._runDestroy(options);
  else if (command === 'schedule')
    return this._runSchedule(options);
  else if (command === 'status')
    return this._runStatus(options);
};

Orchestra.prototype._createDroplets = function _createDroplets(image, keys,
                                                               options,
                                                               callback) {
  async.times(options.count, (i, callback) => {
    this.ocean.dropletsCreate({
      image: image,
      ssh_keys: keys,

      name: 'huffin-' + options.tag + '-' + i,
      region: options.region,
      size: options.size,
      tags: [ 'huffin-' + options.tag ]
    }, (err, res, body) => callback(err, body));
  }, callback);
}


Orchestra.prototype._runSpawn = function _runSpawn(options) {
  async.parallel({
    keys: (callback) => {
      this.ocean.accountGetKeys('*', (err, res, body) => {
        if (err)
          return callback(err);

        const query = options.keys.split(',');
        const keys = body.ssh_keys.filter(({ name }) => query.includes(name));
        callback(null, keys.map(({ id }) => id));
      });
    },
    image: (callback) => {
      this.ocean.imagesGetAll({
        private: true
      }, (err, res, body) => {
        if (err)
          return callback(err);

        const images = body.images.filter(({ name }) => name === options.image);
        assert.equal(images.length, 1, `Image ${options.image} not found`);

        callback(null, images[0].id);
      });
    }
  }, (err, data) => {
    console.log('About to spawn %d droplets', options.count);
    prompt.get('Are you sure?', (err) => {
      if (err)
        throw err;

      this._createDroplets(data.image, data.keys, options, (err, drops) => {
        if (err)
          throw new Error(err.message);

        console.log('Spawned %d droplets', drops.length);
      });
    });
  });
};

Orchestra.prototype._destroyDroplets = function _destroyDroplets(ids,
                                                                 callback) {
  async.forEach(ids, (id, callback) => {
    this.ocean.dropletsDelete(id, callback);
  }, callback);
};

Orchestra.prototype._runDestroy = function _runDestroy(options) {
  this.ocean.dropletsGetAll({
    tag_name: 'huffin-' + options.tag,
    per_page: 1000
  }, (err, _, body) => {
    if (err)
      throw err.message;

    const names = body.droplets.map(({ name }) => name);
    console.log('Going to destroy %d droplets:', names.length);
    console.log(names.join(', '));
    prompt.get('Are you sure?', (err) => {
      if (err)
        throw err;

      const ids = body.droplets.map(({ id }) => id);
      this._destroyDroplets(ids, (err) => {
        if (err)
          throw new Error(err.message);

        console.log('Deleted %d dropletes', ids.length);
      });
    });
  });
};

Orchestra.prototype._addJob = function _addJob(ip, prefix, email, callback) {
  request.post({
    uri: `https://${ip}:${this.port}/job`,
    servername: 'huffin.generator',
    ca: [ this.cert ],
    json: true,
    auth: {
      user: this.username,
      password: this.passphrase
    },
    body: { prefix, email }
  }, (err, _, body) => callback(err, body));
};

Orchestra.prototype._schedule = function _schedule(droplets, options,
                                                   callback) {
  async.map(droplets, (droplet, callback) => {
    const ip = droplet.networks.v4[0].ip_address;

    this._addJob(ip, options.prefix, options.email, callback);
  }, callback);
};

Orchestra.prototype._runSchedule = function _runSchedule(options) {
  this.ocean.dropletsGetAll({
    tag_name: 'huffin-' + options.tag,
    per_page: 1000
  }, (err, _, body) => {
    if (err)
      throw err.message;

    const names = body.droplets.map(({ name }) => name);
    console.log('Going to schedule "%s" on %d droplets: ', options.prefix,
                names.length);
    console.log(names.join(', '));

    prompt.get('Are you sure?', (err) => {
      if (err)
        throw err;

      this._schedule(body.droplets, options, (err, scheduled) => {
        if (err)
          throw err.message;

        console.log('Scheduled %d jobs', scheduled.length);
        console.log(scheduled);
      });
    });
  });
};

Orchestra.prototype._getStatus = function _getStatus(ip, prefix, callback) {
  request.get({
    uri: `https://${ip}:${this.port}/jobs`,
    servername: 'huffin.generator',
    ca: [ this.cert ],
    json: true,
    auth: {
      user: this.username,
      password: this.passphrase
    }
  }, (err, _, body) => {
    if (err)
      return callback(null, { jobs: [], history: [], queue: [] });
    callback(err, body);
  })
};

Orchestra.prototype._reportStatus = function _reportStatus(droplets, options) {
  async.map(droplets, (droplet, callback) => {
    const ip = droplet.networks.v4[0].ip_address;

    this._getStatus(ip, options.prefix, callback);
  }, (err, statuses) => {
    if (err)
      throw err.message;

    let jobs = [];
    statuses.forEach((status) => {
      jobs = jobs.concat(status.jobs, status.history, status.queue);
    });

    jobs = jobs.filter(job => job.config.prefix === options.prefix);

    const status = new Map();
    const results = [];

    let total = 0;
    let speed = 0;
    jobs.forEach((job) => {
      if (status.has(job.status))
        status.set(job.status, status.get(job.status) + 1);
      else
        status.set(job.status, 1);

      if (job.status === 'running')
        speed += job.stats.ticks * 1e3 / job.elapsed;

      total += job.stats.ticks;
      if (job.result !== null)
        results.push(job.result);
    });

    const space = Math.pow(2, huffin.parsePrefix(options.prefix).bitLength);
    const probability = 1 - Math.pow(1 - 1 / space, total);
    const targetTicks = Math.log(1 - TARGET_PROBABILITY) /
                        Math.log(1 - 1 / space);
    const deltaTicks = Math.max(0, targetTicks - total);
    const seconds = deltaTicks / speed;

    const eta = {
      days: Math.floor(seconds / (3600 * 24)),
      hours: utils.pad2(Math.floor((seconds % (3600 * 24)) / 3600)),
      minutes: utils.pad2(Math.floor((seconds % (3600)) / 60)),
      seconds: utils.pad2(Math.floor(seconds % 60))
    };

    console.log('Status:');
    status.forEach((value, key) => console.log('  %s: %d', key, value));
    console.log('Results: %j', results);
    console.log('Tried: %d keys', total);
    console.log('Speed: %d keys/sec', speed.toFixed(0));
    console.log('Probability: %d%%', (probability * 100).toFixed(2));
    console.log('Eta: %dd %dh %dm %ds', eta.days, eta.hours, eta.minutes,
                eta.seconds);
  });
}

Orchestra.prototype._runStatus = function _runStatus(options) {
  this.ocean.dropletsGetAll({
    tag_name: 'huffin-' + options.tag,
    per_page: 1000
  }, (err, res, body) => {
    if (err)
      throw err.message;

    const names = body.droplets.map(({ name }) => name);
    this._reportStatus(body.droplets, options);
  });
}
