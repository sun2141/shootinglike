import cv2, numpy as np, sys, json
# continue tracking from seed json (last detections), adaptive prediction
v,seed,o,R,N=sys.argv[1],json.load(open(sys.argv[2])),sys.argv[3],int(sys.argv[4]),int(sys.argv[5])
pts=[r for r in seed if r[2] is not None]
start=pts[-1][0]+1
cap=cv2.VideoCapture(v); fr={};ts={}; i=0
while True:
    ok,f=cap.read()
    if not ok or i>start+N+4: break
    if i>=start-4: fr[i]=f; ts[i]=cap.get(cv2.CAP_PROP_POS_MSEC)/1000
    i+=1
trk=[[p[0],p[2],p[3]] for p in pts[-8:]]; out=[]; miss=0
for i in range(start,start+N):
    if i+3 not in fr: break
    a=np.array(trk[-6:],float); 
    px=np.polyval(np.polyfit(a[:,0],a[:,1],2 if len(a)>4 else 1),i); py=np.polyval(np.polyfit(a[:,0],a[:,2],2 if len(a)>4 else 1),i)
    RR=R+8*miss; x0,y0=int(max(0,px-RR)),int(max(0,py-RR)); x1,y1=int(px+RR),int(py+RR)
    c=fr[i][y0:y1,x0:x1].astype(np.int16)
    gray=c.mean(2); sat=c.max(2)-c.min(2)
    mot=np.minimum(np.abs(c-fr[i-3][y0:y1,x0:x1]).max(2),np.abs(c-fr[i+3][y0:y1,x0:x1]).max(2))
    m=((mot>25)&(gray>130)&(sat<80)).astype(np.uint8)
    n,lab,st,cen=cv2.connectedComponentsWithStats(m); best=None
    for k in range(1,n):
        if st[k,4]<3: continue
        bx,by=cen[k][0]+x0,cen[k][1]+y0; d=np.hypot(bx-px,by-py)
        if d>RR: continue
        if best is None or d<best[0]: best=(d,bx,by,int(st[k,2]),int(st[k,3]),int(st[k,4]))
    if best is None:
        miss+=1; out.append([i,ts[i],None,None,0,0,0,round(px,1),round(py,1)])
        if miss>8: break
        continue
    miss=0; trk.append([i,best[1],best[2]])
    out.append([i,ts[i],round(best[1],1),round(best[2],1),best[3],best[4],best[5]])
json.dump(seed+out,open(o,'w'))
for r in out: print(r)
