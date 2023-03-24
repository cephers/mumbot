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
    this.info('construct: ', util.inspect(opt));
    this.initRead = true;
    this.opt = opt;
    this.logData = '';
    this.mumbleState = new Map();
    this.diffMumbleState = new Map();
    this.lastReport = 0;
    this.lastNewUsers = [];
    this.reportTimer = null;
    this.ircClient = null;
    this.tail = null;
  }
  run() {
    this.handleSighup();
    this.makeIrcClient();
    this.readLog();
  }
  handleSighup() {
    const self = this;
    process.on('SIGHUP', () => {
      self.info('SIGHUP');
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
    this.ircClient.addListener('registered', this.handleIrcRegistered.bind(this));
    this.ircClient.addListener('message', this.handleIrcMessage.bind(this));
    this.ircClient.addListener('raw', this.handleIrcRaw.bind(this));
    this.ircClient.addListener('error', this.handleIrcError.bind(this));
  }
  readLog() {
    const self = this;
    const cat = child_process.spawn('cat', [ this.opt.logfile ]);
    cat.stdout.on('data', this.handleMumbledLogData.bind(this));
    cat.on('close', function () {
      self.initRead = false;
      self.tailLog();
    });
  }
  tailLog() {
    if (this.initRead) {
      return;
    }
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
    // this.info('irc_raw: ' + util.inspect(msg, { compact: true, breakLength: Infinity }));
  }
  handleIrcError(msg) {
    this.err('irc_err: ' + util.inspect(msg));
  }
  handleMumbledLogData(data) {
    this.logData += data;
    let pos = 0;
    let nl;
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
    const lastMumbleState = new Map(this.mumbleState);
    let m;
    if ((m = line.match(/<\d+:([^(]+)\(-?\d+\)+> Authenticated/)) !== null) {
      this.mumbleState.set(m[1], 'root');
    } else if ((m = line.match(/<\d+:([^(]+)\(-?\d+\)+> Connection closed/)) !== null) {
      this.mumbleState.delete(m[1]);
    } else if ((m = line.match(/<\d+:([^(]+)\(-?\d+\)+> Moved .+? to #(.+?)\[\d+:\d+\]$/)) !== null) {
      this.mumbleState.set(m[1], m[2]);
    } else {
      return;
    }
    if (this.initRead) {
      return;
    }
    this.info('mumbleState: ' + util.inspect(this.mumbleState));
    if (this.mumbleState.size > lastMumbleState.size) {
      const now = Date.now();
      const lastPlusDelay = this.lastReport + (+this.opt.mindelay * 1000);
      if (now > lastPlusDelay) {
        this.info('Reporting now');
        if (this.reportTimer !== null) {
          clearTimeout(this.reportTimer);
          this.reportTimer = null;
        }
        this.diffMumbleState = new Map(lastMumbleState);
        this.report();
      } else if (this.reportTimer === null) {
        this.info('Reporting in the future');
        this.diffMumbleState = new Map(lastMumbleState);
        this.reportTimer = setTimeout(this.report.bind(this), lastPlusDelay - now);
      } else {
        this.info('Report already scheduled');
      }
    }
  }
  report() {
    let newUsers = [];
    for (let [user, chan] of this.mumbleState) {
      if (!this.diffMumbleState.has(user)) {
        newUsers.push(user);
      }
    }
    newUsers.sort();

    if (newUsers.length < 1 || JSON.stringify(newUsers) === JSON.stringify(this.lastNewUsers)) {
      return;
    }

    this.lastNewUsers = newUsers.slice();
    this.lastReport = Date.now();
    this.reportTimer = null;

    let what = newUsers.join(', ') + ' joined mumble';
    if (newUsers.length !== this.mumbleState.size) {
      what += ' (' + this.mumbleState.size + ' users online)'
    }
    this.info('irc_out: ' + what);
    this.ircClient.say(this.opt.chan, what);
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
