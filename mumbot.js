#!/usr/bin/env node
'use strict';

const irc = require('irc');
const child_process = require('node:child_process');
const getopt = require('node-getopt');
const util = require('util');
const process = require('process');

const DEFAULT_IRC_SERVER = 'irc.wetfish.net';
const DEFAULT_IRC_PORT = 6697;
const DEFAULT_IRC_CHAN = '#wetfish';
const DEFAULT_IRC_NICK = 'mumbot';
const DEFAULT_IRC_PASS = null;
const DEFAULT_MUMBLED_LOG = '/var/log/mumble-server/mumble-server.log';
const DEFAULT_IRC_MIN_DELAY_S = 300;

const opt = getopt.create([
  [ 'h', 'help',          'Show this help' ],
  [ 's', 'server=SERVER', 'IRC server to connect to (default: ' + DEFAULT_IRC_SERVER + ')' ],
  [ 'p', 'port=PORT'    , 'IRC port to connec to (default: ' + DEFAULT_IRC_PORT + ')' ],
  [ 'c', 'chan=CHAN',     'IRC channel to join (default: ' + DEFAULT_IRC_CHAN + ')' ],
  [ 'n', 'nick=NICK',     'IRC nick (default: ' + DEFAULT_IRC_NICK + ')' ],
  [ 'P', 'pass=PASS',     'IRC pass (default: ' + DEFAULT_IRC_PASS + ')' ],
  [ 'f', 'logfile=FILE',  'mumbled log path (default: ' + DEFAULT_MUMBLED_LOG + ')' ],
  [ 'd', 'mindelay=SECS', 'Min time between chats (default: ' + DEFAULT_IRC_MIN_DELAY_S + ')' ],
]).bindHelp().parseSystem();

opt.options.server ||= DEFAULT_IRC_SERVER;
opt.options.port ||= DEFAULT_IRC_PORT;
opt.options.chan ||= DEFAULT_IRC_CHAN;
opt.options.nick ||= DEFAULT_IRC_NICK;
opt.options.pass ||= DEFAULT_IRC_PASS;
opt.options.logfile ||= DEFAULT_MUMBLED_LOG;
opt.options.mindelay ||= DEFAULT_IRC_MIN_DELAY_S;

(new class {
  constructor(opt) {
    this.info('construct: ', util.inspect(this.opt));
    this.opt = opt;
    this.logData = '';
    this.mumbleState = new Map();
    this.lastReport = 0;
    this.reportTimer = null;
    this.ircClient = null;
    this.tail = null;
  }
  run() {
    this.handleSighup();
    this.makeIrcClient();
    this.tailLog();
  }
  handleSighup() {
    const self = this;
    process.on('SIGHUP', () => {
      this.info('SIGHUP');
      self.tailLog();
    });
  }
  makeIrcClient() {
    this.info('makeIrcClient');
    this.ircClient = new irc.Client(
      this.opt.server,
      this.opt.nick,
      {
        userName: this.opt.nick,
        realName: this.opt.nick,
        password: this.opt.pass,
        port: this.opt.port,
        // sasl: true,
        secure: true,
        channels: [ this.opt.chan ],
      },
    );
    this.ircClient.addListener('registered', this.handleIrcRegistered);
    this.ircClient.addListener('message', this.handleIrcMessage);
    this.ircClient.addListener('raw', this.handleIrcRaw);
    this.ircClient.addListener('error', this.handleIrcError);
  }
  tailLog() {
    this.info('tailLog');
    if (this.tail) {
      this.tail.kill();
    }
    this.tail = child_process.spawn('tail', [ '-Fn0', this.opt.logfile ]);
    this.tail.stdout.on('data', this.handleMumbledLogData.bind(this));
    this.tail.on('close', this.handleMumbledLogClose.bind(this));
  }
  handleIrcRegistered() {
    this.info('irc_registered');
  }
  handleIrcMessage(nick, to, text, msg) {
    // TODO mumbot commands
  }
  handleIrcRaw(msg) {
    this.info('irc_raw: ' + util.inspect(msg, { compact: true, breakLength: Infinity }));
  }
  handleIrcError(msg) {
    this.err('irc_err: ' + util.inspect(msg));
  }
  handleMumbledLogData(data) {
    this.logData += data;
    var pos = 0;
    var nl;
    while ((nl = this.logData.indexOf('\n')) !== -1) {
      const line = this.logData.substring(pos, nl);
      this.parseMumbledLog(line);
      this.logData = this.logData.substring(nl + 1);
    }
  }
  parseMumbledLog(line) {
    // <85:commie(-1)> Authenticated
    // <85:commie(-1)> Connection closed: ...
    // <89:commie(-1)> Moved commie:89(-1) to #StephersFanClub[9:7]
    var m;
    var diff = false;
    if ((m = line.match(/<\d+:([^(]+)\(-?\d+\)+> Authenticated/)) !== null) {
      this.mumbleState.set(m[1], 'root');
      diff = true;
    } else if ((m = line.match(/<\d+:([^(]+)\(-?\d+\)+> Connection closed/)) !== null) {
      this.mumbleState.delete(m[1]);
      diff = true;
    } else if ((m = line.match(/<\d+:([^(]+)\(-?\d+\)+> Moved .+? to #(.+?)\[\d+:\d+\]$/)) !== null) {
      this.mumbleState.set(m[1], m[2]);
    } else {
      return;
    }
    this.info('mumbleState: ' + util.inspect(this.mumbleState));
    if (!diff) {
      return;
    }
    const now = Date.now();
    const lastPlusDelay = this.lastReport + (+this.opt.mindelay * 1000);
    if (now > lastPlusDelay) {
      if (this.reportTimer !== null) {
        clearTimeout(this.reportTimer);
      }
      this.report();
    } else if (this.reportTimer === null) {
      this.reportTimer = setTimeout(this.report.bind(this), lastPlusDelay - now);
    }
  }
  report() {
    this.lastReport = Date.now();
    this.reportTimer = null;
    var what;
    if (this.mumbleState.size < 1) {
      return;
    } else if (this.mumbleState.size === 1) {
      what = 'One user is on mumble!';
    } else {
      what = this.mumbleState.size + ' users are on mumble!';
    }
    this.info('irc_out: ' + what);
    this.ircClient.say(this.chan, what);
  }
  handleMumbledLogClose() {
    this.err('log_close');
  }
  err(s) {
    this.log('E', s);
  }
  info(s) {
    this.log('I', s);
  }
  log(lvl, s) {
    const lines = s.split('\n');
    lines.forEach(line => {
      const linef = [ '[', Date.now(), '] [', lvl, '] ', line ].join('');
      if (lvl === 'I') {
        console.log(linef);
      } else {
        console.error(linef);
      }
    });
  }
}(opt.options)).run();
