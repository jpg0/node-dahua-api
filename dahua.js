#!/usr/bin/nodejs
// Dahua HTTP API Module
var events    = require('events');
var request   = require('request');
var progress = require('request-progress');
var NetKeepAlive = require('net-keepalive')

var setKeypath = require('keypather/set');
var fs = require('fs');
var path = require('path');
var moment = require('moment');
const debug = require('debug')('http')

class DahuaCam extends events.EventEmitter {
  constructor(options) {
    super();
    
    this.baseUri = `http://${options.host}:${options.port}`;
    this.camUser = options.user;
    this.camPass = options.pass;
    this.camHost = options.host;
    this.camPort = options.port;
    this.camBrand = options.camBrand;
    this.camModel = options.camModel;
    this.queue = options.queue;
    // Set default values if they are missing
    if (options.queue === undefined) {
        this.queue = [{}];
    }
    
    
    /**
     * This initializes the default status for each camera. This is deliberately spelled incorrectly to match the values
     * returned by the camera. Here is an actual example of data returned by the camera:
     * 
     * Camera data: status.Focus.FocusPosition=4680.000000,status.Focus.Status=Unknown,status.Iris.IrisValue=11.000000,status.Iris.Status=Idle,status.MoveStatus=Moving,status.PTS=0,status.Postion[0]=33.800000,status.Postion[1]=0.000000,status.Postion[2]=1.000000,status.PresetID=0,status.Sequence=0,status.UTC=0,status.ZoomStatus=Idle,status.ZoomValue=100,
     * getStatus data returned by the camera will be parsed into an object, then set to the 'status' for the object.
     */
    this.status = JSON.parse('{"status.Focus.FocusPosition":"4680.000000","status.Focus.Status":"Unknown","status.Iris.IrisValue":"11.000000","status.Iris.Status":"Idle","status.MoveStatus":"Moving","status.PTS":"0","status.Postion[0]":"33.800000","status.Postion[1]":"0.000000","status.Postion[2]":"1.000000","status.PresetID":"0","status.Sequence":"0","status.UTC":"0","status.ZoomStatus":"Idle","status.ZoomValue":"100"}');

    if ( options.active === undefined ) {
      options.active = true;
    } 

    if ( options.active ) { this.client = this.connect(options) };

    this.on('error',function(err){
      debug("Error: " + err);
    });

  };

  // set up persistent connection to receive alarm events from camera
  connect(options) {
    
      var opts = { 
        'url' : this.baseUri + '/cgi-bin/eventManager.cgi?action=attach&codes=[AlarmLocal,VideoMotion,VideoLoss,VideoBlind]',
        'forever' : true,
        'headers': {'Accept':'multipart/x-mixed-replace'}
      };

      var client = request(opts).auth(this.camUser,this.camPass,false);

      client.on('socket', (socket) => {
        // Set keep-alive probes - throws ESOCKETTIMEDOUT error after ~16min if connection broken
        NetKeepAlive.setKeepAliveInterval(socket, 1000);
        debug('TCP_KEEPINTVL:',NetKeepAlive.getKeepAliveInterval(socket)); 
        
        NetKeepAlive.setKeepAliveProbes(socket, 1);
        debug('TCP_KEEPCNT:',NetKeepAlive.getKeepAliveProbes(socket));
        
      });

      client.on('response', () => this.handleDahuaEventConnection(options));
      client.on('error', err => this.handleDahuaEventError(err));
      client.on('data', data => this.handleDahuaEventData(data));
      client.on('close', () => {   // Try to reconnect after 30s
        () => setTimeout(() => this.connect(options), 30000);
        handleDahuaEventEnd();
      });
  };


  /**
   * These are the PTZ control commands. It is used to start or stop the PTZ control.
   * URL syntax: http://<ip>/cgi-bin/ptz.cgi?action=[action]&channel=[ch]&code=[code]&arg1=[argstr]& arg2=[argstr]&arg3=[argstr]&arg4=[argstr]
   * action is PTZ control command, it can be start or stop.
   * ch is PTZ channel range is [0 - n-1], code is PTZ operation, and arg1, arg2, arg3, arg4 are the arguments of operation. 
   * Code and argstr values are listed below in arrays.
   * RESPONSE: OK or ERROR
   * @param {*} action ['start','stop']
   * @param {*} chnl   0 to n-1
   * @param {*} cmd    Allowed commands are in the function: checkCmdValue(cmd)
   * @param {*} arg1 
   * @param {*} arg2 
   * @param {*} arg3 
   * @param {*} arg4 
   */
  ptzCommand(action,chnl,cmd,arg1,arg2,arg3,arg4) {
    var self = this;
    debug('ptzCommand: action: '+action+' chnl: '+chnl+' cmd: '+cmd+' arg1: '+arg1+' arg2: '+arg2+' arg3: '+arg3+' arg4: '+arg4);
    
    actionAry = ["start","stop"]
    chnl = forceInt(chnl)
    cmd = checkCmdValue(cmd); // verify the cmd passed in is a valid value
    arg1 = forceInt(arg1);
    arg2 = forceInt(arg2);
    if (cmd != "SetPresetName") arg3 = forceInt(arg3); 
    arg4 = forceInt(arg4);
    
    if (((actionAry.indexOf(action)) || chnl || cmd || arg1 || arg2 || arg3 || arg4) == -1) {
      self.emit("error",'INVALID PTZ COMMAND');
      return 0;
    }
    request(this.baseUri + '/cgi-bin/ptz.cgi?action=start&channel=0&code=' + cmd + '&arg1=' + arg1 + '&arg2=' + arg2 + '&arg3=' + arg3 + '&arg4=' + arg4, function (error, response, body) {
      if ((error) || (response.statusCode !== 200) || (body.trim() !== "OK")) {
        self.emit("error", 'FAILED TO ISSUE PTZ COMMAND');
      }
    }).auth(this.camUser,this.camPass,false);
  };

  ptzPreset(preset) {
    var self = this;
    if (isNaN(preset)) {
      self.emit("error",'INVALID PTZ PRESET');
      return 0;
    }
    preset = parseInt(preset)
    request(this.baseUri + '/cgi-bin/ptz.cgi?action=start&channel=0&code=GotoPreset&arg1=0&arg2=' + preset + '&arg3=0', function (error, response, body) {
      if ((error) || (response.statusCode !== 200) || (body.trim() !== "OK")) {
        self.emit("error", 'FAILED TO ISSUE PTZ PRESET');
      }
    }).auth(this.camUser,this.camPass,false);
  };

  ptzZoom(action,arg2) {
    var self = this;
    // Check the action & arg2 values to ensure they are safe
    if (['start','stop'].indexOf(action) == -1) {
      action = stop;
    }
    if (isNaN(arg2)) {
      self.emit("error",'INVALID PTZ ZOOM');
      return 0;
    } 
    if (arg2 > 0) cmd = 'ZoomTele';
    if (arg2 < 0) cmd = 'ZoomWide';
    if (arg2 === 0) return 0;

    request(this.baseUri + '/cgi-bin/ptz.cgi?action=' + action + '&channel=0&code=' + cmd + '&arg1=0&arg2=1&arg3=0', function (error, response, body) {
      if ((error) || (response.statusCode !== 200) || (body.trim() !== "OK")) {
        self.emit("error", 'FAILED TO ISSUE PTZ ZOOM');
      }
    }).auth(this.camUser,this.camPass,false);
  };

  /**
   * These are the MOVE commands subset of the PTZ control commands. This starts or stops the PTZ control movement.
   * URL syntax: http://<ip>/cgi-bin/ptz.cgi?action=[action]&channel=[ch]&code=[code]&arg1=[argstr]& arg2=[argstr]&arg3=[argstr]&arg4=[argstr]
   * action is PTZ control command, it can be start or stop.
   * ch is PTZ channel range is [0 - n-1], code is PTZ operation, and arg1, arg2, arg3, arg4 are the arguments of operation. 
   * Code and argstr values are listed below in arrays.
   * RESPONSE: OK or ERROR
   * 
   * NOTE: This function only contains the move actions. Other actions should be in the ptzCommand function.
   * 
   * @param {*} direction       "is code from the url" 
   * @param {*} action          "['start','stop']"
   * @param {*} verticalSpeed   "integer range: [1-8]"
   * @param {*} horizontalSpeed "integer range: [1-8]"
   */
  ptzMove(direction,action,verticalSpeed,horizontalSpeed) {
    var self = this;
    // An array of allowed list of action values.
    var actionAry = ['start','stop']
    // This is the allowed list of movements. Some can be destructive. 
    var directionAry = ["Up", "Down", "Left", "Right", "ZoomWide", "ZoomTele", "FocusNear", "FocusFar", "IrisLarge", "IrisSmall", "GotoPreset", "StartTour", "LeftUp", "RightUp", "LeftDown", "RightDown", "AutoPanOn", "AutoPanOff", "AutoScanOn", "AutoScanOff", "StartPattern", "StopPattern", "Position",  "PositionABS", "PositionReset", "UpTele", "DownTele", "LeftTele", "RightTele", "LeftUpTele", "LeftDownTele", "RightUpTele", "RightDownTele", "UpWide", "DownWide", "LeftWide", "RightWide", "LeftUpWide", "LeftDownWide", "RightUpWide", "RightDownWide", "Continuously", "Relatively"]
    var verticalSpeed = parseInt(verticalSpeed);
    var horizontalSpeed = parseInt(horizontalSpeed);
    var speed = 4;
    if (!isNaN(verticalSpeed) && isNaN(horizontalSpeed)) horizontalSpeed = verticalSpeed
    if (verticalSpeed > 0) speed = verticalSpeed;

    debug('ptzMove: direction,action,verticalSpeed,horizontalSpeed ',direction,action,verticalSpeed,horizontalSpeed);
    if (isNaN(verticalSpeed)) {
      self.emit("error",'INVALID PTZ VERTICAL SPEED');
      return 0;
    }
    if (isNaN(horizontalSpeed)) {
      self.emit("error",'INVALID PTZ HORIZONTAL SPEED');
      return 0;
    }
    if (actionAry.indexOf(action) == -1) {
      self.emit("error",'INVALID PTZ COMMAND');
      return 0;
    }
    if (directionAry.indexOf(direction) == -1) {
      self.emit("error",'INVALID PTZ DIRECTION');
      return 0;
    }
    request(this.baseUri + '/cgi-bin/ptz.cgi?action=' + action + '&channel=0&code=' + direction + '&arg1=' + verticalSpeed +'&arg2=' + horizontalSpeed + '&arg3=0', function (error, response, body) {
      if ((error) || (response.statusCode !== 200) || (body.trim() !== "OK")) {
        self.emit("error", 'FAILED TO ISSUE PTZ UP COMMAND');
      }
    }).auth(this.camUser,this.camPass,false);
  };

  ptzStatus() {
    var self = this;
    request(this.baseUri + '/cgi-bin/ptz.cgi?action=getStatus', function (error, response, body) {
      if ((!error) && (response.statusCode === 200)) {
        body = body.toString().split('\r\n');
        self.emit("ptzStatus", body);
      } else {
        self.emit("error", 'FAILED TO QUERY STATUS');
      }
    }).auth(this.camUser,this.camPass,false);
  };

  // function to parse the getStatus() data
  parseStatusData(camConnection, statusData) {
    var params = {}, queries, temp, i, l;
    if (camConnection == null || statusData == null) {
      return params;
    }
    
    // The status data may be an array or a string, so convert strings to an array
    if (statusData.constructor == Array) {
      queries = statusData;
    } else if (statusData.constructor == String) {
      // Split into key/value pairs
      queries = statusData.split(",");
    }
    
    // Convert the array of strings into an object with a name and a value
    for ( i = 0, l = queries.length; i < l; i++ ) {
        temp = queries[i].split('=');
        var testResult = (temp[0].trim() == '');
        if (!testResult) { params[temp[0]] = temp[1]; };
    }
    return params;
  }

  dayProfile() {
    var self = this;
    request(this.baseUri + '/cgi-bin/configManager.cgi?action=setConfig&VideoInMode[0].Config[0]=1', function (error, response, body) {
      if ((!error) && (response.statusCode === 200)) {
        if (body === 'Error') {   // Didnt work, lets try another method for older cameras
          request(this.baseUri + '/cgi-bin/configManager.cgi?action=setConfig&VideoInOptions[0].NightOptions.SwitchMode=0', function (error, response, body) { 
            if ((error) || (response.statusCode !== 200)) {
              self.emit("error", 'FAILED TO CHANGE TO DAY PROFILE');
            }
          }).auth(this.camUser,this.camPass,false);
        }
      } else {
        self.emit("error", 'FAILED TO CHANGE TO DAY PROFILE');
      } 
    }).auth(this.camUser,this.camPass,false);
  };

  nightProfile() {
    var self = this;
    request(this.baseUri + '/cgi-bin/configManager.cgi?action=setConfig&VideoInMode[0].Config[0]=2', function (error, response, body) {
      if ((!error) && (response.statusCode === 200)) {
        if (body === 'Error') {   // Didnt work, lets try another method for older cameras
          request(this.baseUri + '/cgi-bin/configManager.cgi?action=setConfig&VideoInOptions[0].NightOptions.SwitchMode=3', function (error, response, body) { 
            if ((error) || (response.statusCode !== 200)) {
              self.emit("error", 'FAILED TO CHANGE TO NIGHT PROFILE');
            }
          }).auth(this.camUser,this.camPass,false);
        }
      } else {
        self.emit("error", 'FAILED TO CHANGE TO NIGHT PROFILE');
      } 
    }).auth(this.camUser,this.camPass,false);
  };


  /*====================================
  =            File Finding            =
  ====================================*/

  findFiles(query){
      
      var self = this;
      
      if ((!query.channel) || (!query.startTime) || (!query.endTime)) {
        self.emit("error",'FILE FIND MISSING ARGUMENTS');
        return 0;
      }
      
      // create a finder
      this.createFileFind();

      // start search
      this.on('fileFinderCreated',function(objectId){
        debug('fileFinderId:',objectId);
        self.startFileFind(objectId,query.channel,query.startTime,query.endTime,query.types);
      });

      // fetch results
      this.on('startFileFindDone',function(objectId,body){
        debug('startFileFindDone:',objectId,body);   
        self.nextFileFind(objectId,query.count);
      });

      // handle the results 
      this.on('nextFileFindDone',function(objectId,items){

        debug('nextFileFindDone:',objectId);
        items.query = query;
        self.emit('filesFound',items);  
        self.closeFileFind(objectId);
      
      });

      // close and destroy the finder
      this.on('closeFileFindDone',function(objectId,body){
        debug('closeFileFindDone:',objectId,body);
        self.destroyFileFind(objectId);
      });

      this.on('destroyFileFindDone',function(objectId,body){
        debug('destroyFileFindDone:',objectId,body);
      });

  };

  // 10.1.1 Create
  // URL Syntax
  // http://<ip>/cgi-bin/mediaFileFind.cgi?action=factory.create
  
  // Comment
  // Create a media file finder
  // Response
  // result=08137
  
  createFileFind() {
    var self = this;
    request(this.baseUri + '/cgi-bin/mediaFileFind.cgi?action=factory.create', function (error, response, body) {
      if ((error)) {
        self.emit("error", 'ERROR ON CREATE FILE FIND COMMAND');
      }
      // stripping 'result=' and returning the object ID
      var oid = body.trim().substr(7);
      self.emit("fileFinderCreated",oid);

    }).auth(this.camUser,this.camPass,false);

  };


  // 10.1.2 StartFind
  
  // URL Syntax
  // http://<ip>/cgi-bin/mediaFileFind.cgi?action=findFile&object=<objectId>&condition.Channel=<channel>&condition.StartTime= <start>&condition.EndT ime=<end>&condition.Dirs[0]=<dir>&condition.Types[0]=<type>&condition.Flag[0]=<flag>&condition.E vents[0]=<event>

  // Comment
  // Start to find file wth the above condition. If start successfully, return true, else return false.
  // object : The object Id is got from interface in 10.1.1 Create
  // condition.Channel: in which channel you want to find the file .
  // condition.StartTime/condition.EndTime: the start/end time when recording.
  // condition.Dirs: in which directories you want to find the file. It is an array. The index starts from 0. The range of dir is {“/mnt/dvr/sda0”, “/mnt/dvr/sda1”}. This condition can be omitted. If omitted, find files in all the directories.
  // condition.Types: which types of the file you want to find. It is an array. The index starts from 0. The range of type is {“dav”,
  // “jpg”, “mp4”}. If omitted, find files with all the types.
  // condition.Flags: which flags of the file you want to find. It is an array. The index starts from 0. The range of flag is {“Timing”, “Manual”, “Marker”, “Event”, “Mosaic”, “Cutout”}. If omitted, find files with all the flags.
  // condition.Event: by which event the record file is triggered. It is an array. The index starts from 0. The range of event is {“AlarmLocal”, “VideoMotion”, “VideoLoss”, “VideoBlind”, “Traffic*”}. This condition can be omitted. If omitted, find files of all the events.
  // Example:
  // Find file in channel 1, in directory “/mnt/dvr/sda0",event type is "AlarmLocal" or "VideoMotion", file type is “dav”, and time between 2011-1-1 12:00:00 and 2011-1-10 12:00:00 , URL is: http://<ip>/cgi-bin/mediaFileFind.cgi?action=findFile&object=08137&condition.Channel=1&conditon.Dir[0]=”/mnt/dvr/sda0”& conditon.Event[0]=AlarmLocal&conditon.Event[1]=V ideoMotion&condition.StartT ime=2011-1-1%2012:00:00&condition.EndT i me=2011-1-10%2012:00:00

  // Response
  // OK or Error
  // 

  // To be Done: Implement Dirs, Types, Flags, Event Args

  startFileFind(objectId,channel,startTime,endTime,types) { // Dirs,Types,Flags,Event) {
    var self = this;
    if ((!objectId) || (!channel) || (!startTime) || (!endTime) ) {
      self.emit("error",'INVALID FINDFILE COMMAND - MISSING ARGS');
      return 0;
    }

    types = types || [];
    var typesQueryString = "";

    types.forEach(function(el,idx){
      typesQueryString += '&condition.Types[' + idx + ']=' + el;
    });

    var url = this.baseUri + '/cgi-bin/mediaFileFind.cgi?action=findFile&object=' + objectId + '&condition.Channel=' + channel + '&condition.StartTime=' + startTime + '&condition.EndTime=' + endTime + typesQueryString;
    
    request(url, function (error, response, body) {
      if ((error)) {
        debug('startFileFind Error:',error);
        self.emit("error", 'FAILED TO ISSUE FIND FILE COMMAND', error);
      } else {
        debug('startFileFind Response:',body.trim());

        // no results = http code 400 ? 
        //if(response.statusCode == 400 ) {
        //  self.emit("error", 'FAILED TO ISSUE FIND FILE COMMAND - NO RESULTS ?');
        //} else {
        //
          self.emit('startFileFindDone',objectId,body.trim());
        //}
      }
    }).auth(this.camUser,this.camPass,false);

  };


  // 10.1.3 FindNextFile
  // URL Syntax
  
  // http://<ip>/cgi-bin/mediaFileFind.cgi?action=findNextFile&object=<objectId>&count=<fileCount>
  
  // Comment
  // Find the next fileCount files.
  // The maximum value of fileCount is 100.
  
  // Response
  // found=1
  // items[0]. Channel =1
  // items[0]. StartTime =2011-1-1 12:00:00
  // items[0]. EndTime =2011-1-1 13:00:00
  // items[0]. Type =dav
  // items[0]. Events[0]=AlarmLocal
  // items[0]. FilePath =/mnt/dvr/sda0/2010/8/11/dav/15:40:50.jpg items[0]. Length =790
  // items[0]. Duration = 3600
  // items[0].SummaryOffset=2354
  // tems[0].Repeat=0
  // items[0].WorkDir=”/mnt/dvr/sda0”
  // items[0]. Overwrites=5
  // items[0]. WorkDirSN=0


  // Response
  // found - Count of found file, found is 0 if no file is found.
  // Channel - Channel
  // StartTime - Start Time
  // EndTime - End time
  // Type - File type
  // Events - Event type.
  // FilePath - filepath.
  // Length - File length
  // Duration - Duration time
  // SummaryOffset - Summary offset
  // Repeat - Repeat file number
  // WorkDir - The file’s directory
  // Overwrites - Overwrite times of the work directory
  // WorkDirSN - Workdir No
  // 
  // 

  nextFileFind(objectId,count) {
    
    var self = this;
    count = count || 100;

    if ((!objectId)) {
      self.emit("error",'INVALID NEXT FILE COMMAND');
      return 0;
    }

    request(this.baseUri + '/cgi-bin/mediaFileFind.cgi?action=findNextFile&object=' + objectId + '&count=' + count, function (error, response, body) {
      if ((error) || (response.statusCode !== 200)) {
        debug('nextFileFind Error:',error);
        self.emit("error", 'FAILED NEXT FILE COMMAND', error);
      }
      
      var items = {};
      var data = body.split('\r\n');
      
      // getting found count
      items.found = data[0].split("=")[1];

      // parsing items
      data.forEach(function(item){
        if(item.startsWith('items[')) {
          var propertyAndValue = item.split("=");
          setKeypath(items, propertyAndValue[0], propertyAndValue[1]);
        }
      });

      self.emit('nextFileFindDone',objectId,items);

    }).auth(this.camUser,this.camPass,false);
  };




  // 10.1.4 Close
  // URL Syntax 
  // http://<ip>/cgi-bin/mediaFileFind.cgi?action=close&object=<objectId>

  // Comment
  // Stop find.

  // Response
  // OK or ERROR

  closeFileFind(objectId) {
    var self = this;
    if ((!objectId)) {
      self.emit("error",'OBJECT ID MISSING');
      return 0;
    }
    request(this.baseUri + '/cgi-bin/mediaFileFind.cgi?action=close&object=' + objectId, function (error, response, body) {
      if ((error) || (response.statusCode !== 200) || (body.trim() !== "OK")) {
        self.emit("error", 'ERROR ON CLOSE FILE FIND COMMAND');
      }
      
      self.emit('closeFileFindDone',objectId,body.trim());

    }).auth(this.camUser,this.camPass,false);

  };

  // 10.1.5 Destroy
  // URL Syntax
  // http://<ip>/cgi-bin/mediaFileFind.cgi?action=destroy&object=<objectId>

  // Comment
  // Close the media file finder.

  // Response
  // OK or ERROR

  destroyFileFind(objectId) {
    var self = this;
    if ((!objectId)) {
      self.emit("error",'OBJECT ID MISSING');
      return 0;
    }
    request(this.baseUri + '/cgi-bin/mediaFileFind.cgi?action=destroy&object=' + objectId, function (error, response, body) {
      if ((error) || (response.statusCode !== 200) || (body.trim() !== "OK")) {
        self.emit("error", 'ERROR ON DESTROY FILE FIND COMMAND');
      }

      self.emit('destroyFileFindDone',objectId,body.trim());

    }).auth(this.camUser,this.camPass,false);
  };

  /*=====  End of File Finding  ======*/


  /*================================
  =            Load File           =
  ================================*/

  // API Description
  // 
  // URL Syntax 
  // http://<ip>/cgi-bin/RPC_Loadfile/<filename>

  // Response
  // HTTP Code: 200 OK
  // Content-Type: Application/octet-stream
  // Content-Length:<fileLength>
  // Body:
  // <data>
  // <data>
  // For example: http://10.61.5.117/cgi-bin/RPC_Loadfile/mnt/sd/2012-07-13/001/dav/09/09.30.37-09.30.47[R][0@0][0].dav

  saveFile(file,filename) {
    var self = this;

    if ((!file)) {
      self.emit("error",'FILE OBJECT MISSING');
      return 0;
    }

    if ((!file.FilePath)) {
      self.emit("error",'FILEPATH in FILE OBJECT MISSING');
      return 0;
    }
    
    if(!filename) {

      if( !file.Channel || !file.StartTime || !file.EndTime || !file.Type ) {
      self.emit("error",'FILE OBJECT ATTRIBUTES MISSING');
      return 0;
      }

      // the fileFind response obejct
      // { Channel: '0',
      // Cluster: '0',
      // Compressed: 'false',
      // CutLength: '634359892',
      // Disk: '0',
      // Duration: '495',
      // EndTime: '2018-05-19 10:45:00',
      // FilePath: '/mnt/sd/2018-05-19/001/dav/10/10.36.45-10.45.00[R][0@0][0].dav',
      // Flags: [Object],
      // Length: '634359892',
      // Overwrites: '0',
      // Partition: '0',
      // Redundant: 'false',
      // Repeat: '0',
      // StartTime: '2018-05-19 10:36:45',
      // Summary: [Object],
      // SummaryOffset: '0',
      // Type: 'dav',
      // WorkDir: '/mnt/sd',
      // WorkDirSN: '0' };

      filename = this.generateFilename(this.camHost,file.Channel,file.StartTime,file.EndTime,file.Type);

    } 
  
    progress(request(this.baseUri + '/cgi-bin/RPC_Loadfile/' + file.FilePath))
    .auth(this.camUser,this.camPass,false)
    .on('progress', function (state) {
      debug(`Downloaded ${Math.floor(state.percent * 100)} % @ ${Math.floor(state.speed / 1000)} KByte/s` );
    })
    .on('response',function(response){
        if (response.statusCode !== 200) {
          self.emit("error", 'ERROR ON LOAD FILE COMMAND');
        } 
    })
    .on('error',function (error){
        if(error.code == "ECONNRESET") {
          self.emit("error", 'ERROR ON LOAD FILE COMMAND - FILE NOT FOUND?');
        } else {
          self.emit("error", 'ERROR ON LOAD FILE COMMAND');
        }
    })
    .on('end',function() {
      self.emit("saveFile", {
        'status':'DONE',
      });
    })
    .pipe(fs.createWriteStream(filename));
    // TBD: file writing error handling

  };




  /*=====  End of Load File  ======*/


  /*====================================
  =            Get Snapshot            =
  ====================================*/

  // API Description
  // 
  // URL Syntax 
  // http://<ip>/cgi-bin/snapshot.cgi? [channel=<channelNo>]

  // Response
  // A picture encoded by jpg

  // Comment
  // The channel number is default 0 if the request is not carried the param.

  getSnapshot(options) {
    var self = this;
    var opts = {};

    if(options === undefined) {
      var options = {};
    }

    opts.channel = options.channel || 0;
    opts.path = options.path || '';
    opts.filename = options.filename || this.generateFilename(this.camHost,opts.channel,moment(),'','jpg');
    
    var saveTo = path.join(opts.path,opts.filename);
    var deletefile = false;
    
    var file = fs.createWriteStream(saveTo);
    
    file.on('finish',()=> {
      if(deletefile) {
        self.emit("getSnapshot", { 'status':"FAIL ECONNRESET or 0 byte received." });
        debug(moment().format(),'FAIL ECONNRESET or 0 byte received. Deleting ',saveTo);
        fs.unlink(saveTo, (err) => {
          if (err) throw err;
        });
      }
    });

    var ropts = {
      'uri' : this.baseUri + '/cgi-bin/snapshot.cgi?' + opts.channel,
    };

    var responseBody = [];
    var responseHeaders = [];

    request(ropts)
    .auth(this.camUser,this.camPass,false)
    .on('data', (chunk) => {
      responseBody.push(chunk); 
    })
    .on('response',function (response) {
      responseHeaders = response.headers;
    })
    .on('end',function(){
      responseBody = Buffer.concat(responseBody);
      responseBodyLength = Buffer.byteLength(responseBody);

      // check if content-length header matches actual recieved length
      if( responseHeaders['content-length'] != responseBodyLength) {
        self.emit("getSnapshot", "WARNING content-length missmatch" );
      }
      
      // empty?
      if(responseHeaders['content-length'] == 0 ) {
        debug(moment().format(),'NOT OK content-length 0');
        deletefile = true;
        file.end();      
      } else {
        deletefile = false;
        self.emit("getSnapshot", {'status':'DONE',});
      }
    })
    .on('error',function(error){
      self.emit("error", 'ERROR ON SNAPSHOT - ' + error.code );
      deletefile = true;
      file.end();
    })
    .pipe(file);
  };

  /*=====  End of Get Snapshot  ======*/
  generateFilename( device, channel, start, end, filetype ) {
    let filename = `${device}_ch${channel}_`;

    // to be done: LOCALIZATION ?
    startDate = moment(start);
    
    filename += startDate.format('YYYYMMDDHHmmss');
    if(end) {
      endDate = moment(end);
      filename += '_' + endDate.format('YYYYMMDDHHmmss');
    }
    filename += '.' + filetype;

    return filename; 
  };


  handleDahuaEventData(data) {
    debug('Data: ' + data.toString());
    data = data.toString().split('\r\n');
    var i = Object.keys(data);
    i.forEach(id => {
      if (data[id].startsWith('Code=')) {
        var alarm = data[id].split(';');
        var code = alarm[0].substr(5);
        var action = alarm[1].substr(7);
        var index = alarm[2].substr(6);
        this.emit("alarm", code,action,index);
      }
    });
  }

  handleDahuaEventConnection(options) {
    debug('Connected to ' + options.host + ':' + options.port);
    this.emit("connect");
  }

  handleDahuaEventEnd() {
    debug("Connection closed!");
    this.emit("end");
  }

  handleDahuaEventError(err) {
    debug("Connection error: " + err);
    this.emit("error", err);
  }
}

/**
 * A function to force a number to an integer, or return -1 if NaN
 */
function forceInt(val) {
  var val = parseInt(val);
  if (isNaN(val)) {
    return -1
  } else {
    return val
  }
}

/**
 * Check allowed command strings. This function checks a passed `cmd` value against the list of allowed values. 
 * It returns the string if it is allowed. If the cmd string isn't allowed, this function returns a value of '-1'
 * @param {*} cmd 
 */
function checkCmdValue(cmd) {
  var allowedCmdCommands = ["Up", "Down", "Left", "Right", "ZoomWide", "ZoomTele", "FocusNear", "FocusFar", "IrisLarge", "IrisSmall", "GotoPreset", "SetPreset", "ClearPreset", "LampWaterClear", "StartTour", "LeftUp", "RightUp", "LeftDown", "RightDown", "AddTour", "DelTour", "ClearTour", "AutoPanOn", "AutoPanOff", "SetLeftLimit", "SetRightLimit", "AutoScanOn", "AutoScanOff", "SetPatternBegin", "SetPatternEnd", "StartPattern", "StopPattern", "ClearPattern", "AlarmSearch", "Position", "AuxOn", "AuxOff", "Menu", "Exit", "Enter", "Esc", "MenuUp", "MenuDown", "MenuLeft", "MenuRight", "Reset", "SetPresetName", "AlarmPtz", "LightController", "PositionABS", "PositionReset", "UpTele", "DownTele", "LeftTele", "RightTele", "LeftUpTele", "LeftDownTele", "RightUpTele", "RightDownTele", "UpWide", "DownWide", "LeftWide", "RightWide", "LeftUpWide", "LeftDownWide", "RightUpWide", "RightDownWide", "Continuously", "Relatively"]
  if (allowedCmdCommands.indexOf(cmd) != -1) {
    return cmd
  } else {
    return -1
  }
}


exports.DahuaCam = DahuaCam;