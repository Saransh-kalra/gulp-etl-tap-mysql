const through2 = require('through2')
import Vinyl = require('vinyl')
import PluginError = require('plugin-error');
const pkginfo = require('pkginfo')(module); // project package.json info into module.exports
const PLUGIN_NAME = module.exports.name;
import * as loglevel from 'loglevel'
const log = loglevel.getLogger(PLUGIN_NAME) // get a logger instance based on the project name
log.setLevel((process.env.DEBUG_LEVEL || 'warn') as log.LogLevelDesc)
import * as mysql from 'mysql'


const from2 = require('from2');
import * as path from 'path'
const util = require('util')


/** wrap incoming recordObject in a Singer RECORD Message object*/
function createRecord(recordObject:Object, streamName: string) : any {
  return {type:"RECORD", stream:streamName, record:recordObject}
}
function createStateRecord(recordObject:Object, streamName: string) : any {
  return {type:"STATE", stream:streamName, record:recordObject}
}

// stream-mode-only gulp vinyl adapter: loads results of mysql call and wraps it in a vinyl file, then returns vinyl file in a readable stream
export function src(virtualFilePath:string, options:any) {
  let fileStream
  let vinylFile
  try {
    let conn = mysql.createConnection(options.connection)    

    // fileStream = require('fs').createReadStream(virtualFilePath)
    fileStream = conn.query(options.sql)
    .on('end', function() {
      log.debug('all rows have been received')
    })    
    .stream()

    log.debug('closing connection when all rows are received')
    conn.end()

    // create a file wrapper that will pretend to gulp that it came from the path represented by virtualFilePath
    vinylFile = new Vinyl({
      base: path.dirname(virtualFilePath),    
      path:virtualFilePath,
      contents:fileStream
    });
  }
  catch (err) {
    throw new PluginError(PLUGIN_NAME, err);
  }

  return from2.obj([vinylFile])
  // pipe our vinyl file (consisting of objects which each represent a row of mysql data) through our built-in plugin below
  .pipe(tapMysql(options))
}


/* This is a gulp-etl plugin. It is compliant with best practices for Gulp plugins (see
https://github.com/gulpjs/gulp/blob/master/docs/writing-a-plugin/guidelines.md#what-does-a-good-plugin-look-like ),
and like all gulp-etl plugins it accepts a configObj as its first parameter */
export async function tapMysql(configObj: any) {
  if (!configObj) configObj = {}

  // let connection = mysql.createConnection(configObj.connection)
  // connection.connect(function(err: any) {
  //   if (err) {
  //     console.log(err.stack)
  //     return
  //   }
  //   console.log('connected as id: ' + connection.threadId)
  // })

  // //convert mysql query function to a promise function to avoid callbacks
  // connection.query = util.promisify(connection.query).bind(connection)

  // //call queryDB and get the results of the query or an empty array if
  // //the last_entry property was not included in the configObjs.state.bookmarks
  // let queryresult = await queryDB(connection, configObj)

  // let messageObj:any

  // //append a record to the new message packet for every element returned from the database
  // for (let i = 0; i < queryresult.length; i++) {
  //   messageObj.appendRecord('queryresults', queryresult[i])
  // }

  // //if the queryresult array is not greater than 0, means we probably didnt query the database or
  // //we didn't get any NEW results backfrom the database
  // //so attach the state bookmark that was sent to us to the new message packet
  // if (!(queryresult.length > 0)) {
  //   messageObj.bookmarks = configObj.bookmarks
  // } else {
  //   //if there are results then find the bookmarkProp, ex: CurrentTime
  //   //get that value and use it to create the bookmarks property of the messagepacket
  //   let bookmarkProp = configObj.bookmarkProp
  //   let lastrow = queryresult[queryresult.length - 1]
  //   messageObj.bookmarks = {
  //     last_entry: lastrow[bookmarkProp]
  //   }
  // }

  // //keep config object sent to us
  // console.log(JSON.stringify(messageObj))

  // async function queryDB(connection: any, configObj:any) {
  //   //if the bookmarks property is included in the state configuration of configObjs
  //   if (configObj.bookmarks) {
  //     //if the last_entry is included in the bookmarks property
  //     //the last entry is not included then we will not query the database ---*
  //     if (configObj.bookmarks.last_entry) {
  //       //grap the last_entry value, could be row number, time, or anything else
  //       let lastReadRow = configObj.bookmarks.last_entry
  //       console.log('lastreadrow: ' + lastReadRow)
  //       try {
  //         //query the database with sql query given by configObjs, with the lastReadRow variable
  //         let result = await connection.query(configObj.sql, [lastReadRow])
  
  //         connection.end()
  //         return result
  //       } catch (error) {
  //         console.log('Error in queryDB: ' + error.stack)
  //         connection.end()
  //         return
  //       }
  //     }
  //   }
  // }

  // creating a stream through which each file will pass - a new instance will be created and invoked for each file 
  // see https://stackoverflow.com/a/52432089/5578474 for a note on the "this" param
  const strm = through2.obj(function (this: any, file: Vinyl, encoding: string, cb: Function) {
    const self = this
    let returnErr: any = null

    // post-process line object
    const handleLine = (lineObj: any, _streamName : string): object | null => {
      lineObj = createRecord(lineObj, _streamName)
      return lineObj
    }

    function newTransformer(streamName : string) {

      let transformer = through2.obj(); // new transform stream, in object mode
  
      // transformer is designed to follow mysql, which emits objects, so dataObj is an Object. We will finish by converting dataObj to a text line
      transformer._transform = function (dataObj: Object, encoding: string, callback: Function) {
        let returnErr: any = null
        let recordnum = 0
        try {
          let handledObj:any = handleLine(dataObj, streamName)
          if (handledObj) {
            let BookmarkProp = configObj.bookmarkProp
            if(recordnum % 1000 == 0) {
              this.push(JSON.stringify(createStateRecord(handledObj.record.BookmarkProp,streamName)))
            }
            let handledLine = JSON.stringify(handledObj)
            log.debug(handledLine)
            this.push(handledLine + '\n');
            recordnum += 1
          }
        } catch (err) {
          returnErr = new PluginError(PLUGIN_NAME, err);
        }
  
        callback(returnErr)
      }
  
      return transformer
    }

    // set the stream name to the file name (without extension)
    let streamName : string = file.stem

    if (file.isNull()) {
      // return empty file
      return cb(returnErr, file)
    }
    else if (file.isBuffer()) {

/*
      parse(file.contents as Buffer, configObj, function(err:any, linesArray : []){
        // this callback function runs when the parser finishes its work, returning an array parsed lines 
        let tempLine: any
        let resultArray = [];
        // we'll call handleLine on each line
        for (let dataIdx in linesArray) {
          try {
            let lineObj = linesArray[dataIdx]
            tempLine = handleLine(lineObj, streamName)
            if (tempLine){
              let tempStr = JSON.stringify(tempLine)
              log.debug(tempStr)
              resultArray.push(tempStr);
            }
          } catch (err) {
            returnErr = new PluginError(PLUGIN_NAME, err);
          }
        }
        let data:string = resultArray.join('\n')

        file.contents = Buffer.from(data)
        
        // we are done with file processing. Pass the processed file along
        log.debug('calling callback')    
        cb(returnErr, file);    
      })
*/
    }
    else if (file.isStream()) {
      file.contents = file.contents
        // .on('data', function (data:any, err: any) {
        //   log.debug(data)
        // })
        .on('error', function (err: any) {
          log.error(err)
          self.emit('error', new PluginError(PLUGIN_NAME, err));
        })
        .pipe(newTransformer(streamName))
        // .on('end', function () {
        // })

      // set extension to match the new filetype; we are outputting a Message Stream, which is an .ndjson file
      file.extname = '.ndjson'

        // after our stream is set up (not necesarily finished) we call the callback
      log.debug('calling callback')    
      cb(returnErr, file);
    }

  })

  return strm
}
