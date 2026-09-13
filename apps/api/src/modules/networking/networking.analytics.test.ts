import { describe,expect,it } from "vitest";
import { NetworkingConfigSchema } from "@app/contracts";
import { calculateNetworkingAnalytics } from "./networking.analytics";

type Input=Parameters<typeof calculateNetworkingAnalytics>[0];
function fixture():Input {
  const stamp=new Date("2030-05-01T23:30:00Z");
  return {
    event:{startDate:new Date("2030-05-01T00:00:00Z"),endDate:new Date("2030-05-03T00:00:00Z")},
    config:NetworkingConfigSchema.parse({timezone:"Africa/Tunis",openingHours:[{date:"2030-05-02",start:"00:00",end:"01:00"}]}),
    profiles:[{id:"a",firstName:"Amel",lastName:"A",status:"ACTIVE",consent:true,visible:true,withdrawnAt:null,lastActiveAt:stamp,sector:"Health"},{id:"b",firstName:"Karim",lastName:"B",status:"ACTIVE",consent:true,visible:true,withdrawnAt:null,lastActiveAt:stamp,sector:"Investment"}],
    interests:Array.from({length:10},(_,index)=>({profileId:"a",targetId:`target-${index}`,action:index===0?"LIKE":"PASS"})),
    connections:[{id:"pair",profileAId:"a",profileBId:"b",createdAt:stamp}],
    messages:[{connectionId:"pair",senderId:"a",createdAt:stamp},{connectionId:"pair",senderId:"b",createdAt:stamp}],
    meetings:[
      {id:"current",requesterId:"a",recipientId:"b",tableId:"active",status:"CONFIRMED",startsAt:new Date("2030-05-01T23:00:00Z"),endsAt:new Date("2030-05-01T23:30:00Z"),createdAt:stamp,requesterCheckedInAt:new Date("2030-05-01T23:03:00Z"),recipientCheckedInAt:new Date("2030-05-01T23:07:00Z")},
      {id:"oldtable",requesterId:"a",recipientId:"b",tableId:"inactive",status:"COMPLETED",startsAt:new Date("2030-05-01T23:30:00Z"),endsAt:new Date("2030-05-02T00:00:00Z"),createdAt:stamp,requesterCheckedInAt:null,recipientCheckedInAt:null},
      {id:"cancelled",requesterId:"a",recipientId:"b",tableId:"active",status:"CANCELLED",startsAt:new Date("2030-05-01T23:30:00Z"),endsAt:new Date("2030-05-02T00:00:00Z"),createdAt:stamp,requesterCheckedInAt:null,recipientCheckedInAt:null},
    ],
    tables:[{id:"active",name:"Table1",location:"Zone A",active:true},{id:"inactive",name:"Old table",location:"Zone B",active:false}],reports:[],audit:[],
  } as unknown as Input;
}
describe("networking report definitions",()=>{
  it("keeps total gestures after pass reset while distinguishing match yield from reciprocity",()=>{
    const input=fixture();
    input.interests=[];
    input.audit=[{actorId:"a",targetId:"b",action:"SWIPE_LIKE"},{actorId:"b",targetId:"a",action:"SWIPE_LIKE"},{actorId:"a",targetId:"c",action:"SWIPE_PASS"}] as unknown as Input["audit"];
    const result=calculateNetworkingAnalytics(input);
    expect(result.likes).toBe(2);expect(result.passes).toBe(1);
    expect(result.matchRate).toBe(0.5);expect(result.interestReciprocityRate).toBe(1);
    expect(result.matchedParticipantsRate).toBe(1);expect(result.messagedParticipantsRate).toBe(1);
  });

  it("groups activity and today's meetings by the event timezone, not UTC",()=>{
    const result=calculateNetworkingAnalytics(fixture(),new Date("2030-05-01T23:40:00Z"));
    expect(result.timeSeries).toEqual([{date:"2030-05-02",matches:1,messages:2,meetings:2}]);
    expect(result.todayMeetings).toBe(2);
  });
  it("uses the same current inventory in the occupancy numerator and denominator",()=>{
    const result=calculateNetworkingAnalytics(fixture());
    expect(result.tableOccupancyRate).toBe(0.5);
    expect(result.tableUsage.find(table=>table.tableId==="active")).toMatchObject({availableMinutes:60,occupiedMinutes:30,occupancyRate:0.5});
    expect(result.tableUsage.find(table=>table.tableId==="inactive")).toMatchObject({active:false,availableMinutes:0,occupiedMinutes:0});
  });
  it("excludes cancelled meetings from engagement and defines reciprocity and punctuality consistently",()=>{
    const result=calculateNetworkingAnalytics(fixture());
    expect(result.engagement.map(profile=>profile.meetings)).toEqual([2,2]);
    expect(result.plannedMeetings).toBe(2);
    expect(result.cancelledMeetings).toBe(1);
    expect(result.responseRate).toBe(1);
    expect(result.meetingConversionRate).toBe(1);
    expect(result.engagementTenSwipesRate).toBe(0.5);
    expect(result.punctuality).toEqual({checkins:2,onTime:1,onTimeRate:0.5,averageDelayMinutes:5});
  });
});
