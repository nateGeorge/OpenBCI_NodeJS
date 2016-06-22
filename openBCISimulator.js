'use strict';

var EventEmitter = require('events').EventEmitter;
var util = require('util');
var stream = require('stream');

var openBCISample = require('./openBCISample');
var k = openBCISample.k;
var now = require('performance-now');


function OpenBCISimulatorFactory() {
    var factory = this;
    
    var _options = {
        accel: true,
        alpha: true,
        boardFailure:false,
        daisy: false,
        drift: 0,
        firmwareVersion: k.OBCIFirmwareV1,
        lineNoise: '60Hz',
        sampleRate: 250,
        serialPortFailure:false,
        verbose: false
    };

    function OpenBCISimulator(portName, options) {
        options = (typeof options !== 'function') && options || {};
        var opts = {};

        stream.Stream.call(this);

        /** Configuring Options */
        if (options.accel === false) {
            opts.accel = false;
        } else {
            opts.accel = _options.accel;
        }
        if (options.alpha === false) {
            opts.alpha = false;
        } else {
            opts.alpha = _options.alpha;
        }
        opts.boardFailure = options.boardFailure || _options.boardFailure;
        opts.daisy = options.daisy || _options.daisy;
        opts.drift = options.drift || _options.drift;
        opts.firmwareVersion = options.firmwareVersion || _options.firmwareVersion;
        opts.lineNoise = options.lineNoise || _options.lineNoise;
        if (options.sampleRate) {
            opts.sampleRate = options.sampleRate;
        } else {
            if (opts.daisy) {
                opts.sampleRate = k.OBCISampleRate125;
            } else {
                opts.sampleRate = k.OBCISampleRate250;
            }
        }
        opts.serialPortFailure = options.serialPortFailure || _options.serialPortFailure;
        opts.verbose = options.verbose || _options.verbose;

        this.options = opts;

        // Bools
        this.connected = false;
        this.sd = {
            active:false,
            startTime: 0
        };
        this.streaming = false;
        // Buffers
        this.buffer = new Buffer(500);
        this.eotBuf = new Buffer("$$$");
        // Numbers
        this.channelNumber = 1;
        this.sampleNumber = -1; // So the first sample is 0
        // Objects
        this.time = {
            current: 0,
            start: now(),
            loop: null
        };
        // Strings
        this.portName = portName || k.OBCISimulatorPortName;

        // Call 'open'
        setTimeout(() => {
            if (this.options.verbose) console.log('Port name: ' + portName);
            if (portName === k.OBCISimulatorPortName) {
                this.emit('open');
                this.connected = true;
            } else {
                var err = new Error('Serialport not open.');
                this.emit('error',err);
            }
        }, 200);

    }

    // This allows us to use the emitter class freely outside of the module
    util.inherits(OpenBCISimulator, stream.Stream);

    OpenBCISimulator.prototype.flush = function() {
        this.buffer.fill(0);
        //if (this.options.verbose) console.log('flushed');
    };

    OpenBCISimulator.prototype.write = function(data,callback) {
        switch (data[0]) {
            case k.OBCIRadioCmdChannelGet:
                if (this.options.firmwareVersion === k.OBCIFirmwareV2) {
                    if (!this.options.boardFailure) {
                        this.emit('data', new Buffer("Success: Channel changed to 0x"));
                        this.emit('data', new Buffer([this.channelNumber]));
                        this.emit('data', this.eotBuf);
                    } else {
                        this.emit('data', new Buffer("Failure: No Board communications; Dongle on channel number: 0x"));
                        this.emit('data', new Buffer([this.channelNumber]));
                        this.emit('data', this.eotBuf);
                    }
                }
                break;
            case k.OBCIRadioCmdChannelSet:
                if (this.options.firmwareVersion === k.OBCIFirmwareV2) {
                    if (!this.options.boardFailure) {
                        this.channelNumber = data[1];
                        this.emit('data', new Buffer("Success: Channel changed to 0x"));
                        this.emit('data', new Buffer([this.channelNumber]));
                        this.emit('data', this.eotBuf);
                    } else {
                        this.emit('data', new Buffer("Failure: No communications from Board. Is your Board on the right channel? Is your Board powered up?"));
                        this.emit('data', this.eotBuf);
                    }
                }
                break;
            case k.OBCIRadioCmdPollTimeSet:
                if (this.options.firmwareVersion === k.OBCIFirmwareV2) {
                    if (!this.options.boardFailure) {
                        this.emit('data', new Buffer("Success: Poll time set"));
                        this.emit('data', this.eotBuf);
                    } else {
                        this.emit('data', new Buffer("Failure: No communications from Board. Is your Board on the right channel? Is your Board powered up?"));
                        this.emit('data', this.eotBuf);
                    }
                }
                break;
            case k.OBCIStreamStart:
                if (!this.stream) this._startStream();
                this.streaming = true;
                break;
            case k.OBCIStreamStop:
                if (this.stream) clearInterval(this.stream); // Stops the stream
                this.streaming = false;
                break;
            case k.OBCIMiscSoftReset:
                if (this.stream) clearInterval(this.stream);
                this.streaming = false;
                this.emit('data', new Buffer(`OpenBCI V3 Simulator\nOn Board ADS1299 Device ID: 0x12345\n${this.options.daisy ? "On Daisy ADS1299 Device ID: 0xFFFFF\n" : ""}LIS3DH Device ID: 0x38422\n${this.options.firmware === k.OBCIFirmwareV2 ? "Firmware: v2\n" : ""}$$$`));
                break;
            case k.OBCISDLogForHour1:
            case k.OBCISDLogForHour2:
            case k.OBCISDLogForHour4:
            case k.OBCISDLogForHour12:
            case k.OBCISDLogForHour24:
            case k.OBCISDLogForMin5:
            case k.OBCISDLogForMin15:
            case k.OBCISDLogForMin30:
            case k.OBCISDLogForSec14:
                // If we are not streaming, then do verbose output
                if (!this.streaming) {
                    this.emit('data', new Buffer('Wiring is correct and a card is present.\nCorresponding SD file OBCI_69.TXT\n$$$'));
                }
                this.sd.active = true;
                this.sd.startTime = now();
                break;
            case k.OBCISDLogStop:
                if (!this.streaming) {
                    if (this.SDLogActive) {
                        this.emit('data', new Buffer(`Total Elapsed Time: ${now() - this.sd.startTime} ms\n`));
                        this.emit('data', new Buffer(`Max write time: ${Math.random()*500} us\n`));
                        this.emit('data', new Buffer(`Min write time: ${Math.random()*200} us\n`));
                        this.emit('data', new Buffer(`Overruns: 0\n$$$`));
                    } else {
                        this.emit('data', new Buffer('No open file to close\n$$$'));
                    }
                }
                this.SDLogActive = false;
                break;
            case k.OBCISyncTimeSet:
                setTimeout(() => {
                    this.emit('data',k.OBCISyncTimeSent);
                    //this._syncStart();
                }, 10);
                break;
            case k.OBCISyncClockServerData:
                this.time.ntp3 = this.time.current;
                this._syncUp(data.slice(1));
                break;
            default:
                break;
        }

        /** Handle Callback */
        if (this.connected) {
            callback(null,'Success!');
        }
    };

    OpenBCISimulator.prototype.drain = function(callback) {
        callback();
        //if (this.options.verbose) console.log('drain');
    };

    OpenBCISimulator.prototype.close = function(callback) {
        if (this.connected) {
            this.emit('close');
        }
        this.connected = false;
        //if (this.options.verbose) console.log('close');
        callback();
    };

    OpenBCISimulator.prototype._startStream = function() {
        var intervalInMS = 1000 / this.options.sampleRate;

        if (intervalInMS < 2) intervalInMS = 2;

        var generateSample = openBCISample.randomSample(k.OBCINumberOfChannelsDefault, k.OBCISampleRate250, this.options.alpha, this.options.lineNoise);

        var getNewPacket = sampNumber => {
            return openBCISample.convertSampleToPacket(generateSample(sampNumber));
        };

        this.stream = setInterval(() => {
            this.emit('data', getNewPacket(this.sampleNumber));
            this.sampleNumber++;
        }, intervalInMS);
    };

    OpenBCISimulator.prototype._syncStart = function() {

        this.time.ntp0 = now();
        var buffer = new Buffer('$a$' + this.time.ntp0);
        this.emit('data',buffer);
    };

    OpenBCISimulator.prototype._syncUp = function(data) {
        // get the first number
        console.log(data.length);
        var halfwayPoint = (data.length / 2);
        this.time.ntp1 = parseFloat(data.slice(0,halfwayPoint-1));
        this.time.ntp2 = parseFloat(data.slice(halfwayPoint));
        console.log('ntp1: ' + this.time.ntp1 + ' ntp2: ' + this.time.ntp2);

        var timeSpentOnNetwork = this.time.ntp3 - this.time.ntp0 - (this.time.ntp2 - this.time.ntp1);

        var transferTime = timeSpentOnNetwork / 2;

        var trueTime = this.time.ntp2 + transferTime;

        var delta = trueTime - this.time.ntp3;
        console.log('Delta: ' + delta);

        this.time.start += delta;



        this.emit('data','Synced!' + '$$$');

    };

    factory.OpenBCISimulator = OpenBCISimulator;

}

util.inherits(OpenBCISimulatorFactory, EventEmitter);

module.exports = new OpenBCISimulatorFactory();
