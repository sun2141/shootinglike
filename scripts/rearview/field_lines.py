from solve import *
import json
pts=np.array(json.load(open('/mnt/user-data/uploads/shooting-like/ref-rear/_work/lines04.json')))
x,y=pts[:,0],pts[:,1]
lineY=605+0.1082*(x-90)
pen=pts[((x>240)&(x<980)&(np.abs(y-lineY)<5))|((x>1120)&(x<1900)&(np.abs(y-lineY)<6)&(y>650))]
arc=pts[((x<1000)&(x>90)&(y-lineY>8)&(y>640))|((x<210)&(x>90)&(y<640)&(y>612)&(y-lineY<-3))]
ga=pts[(x>1230)&(y<642)&(y>608)&(x<1760)]
print(len(pen),len(arc),len(ga))
def score(f,W,H,verbose=False):
    R,t,C,e=pose(f,W,H)
    g=lambda P: np.array([ray_plane(f,R,t,p,0) for p in P])
    Pp=g(pen); Pa=g(arc); Pg=g(ga)
    rp=Pp[:,1]+16.5; rg=Pg[:,1]+5.5; ra=np.hypot(Pa[:,0],Pa[:,1]+11)-9.15
    if verbose: print(f'  pen y mean {-Pp[:,1].mean():.2f} sd {Pp[:,1].std():.2f} | goal-area y mean {-Pg[:,1].mean():.2f} sd {Pg[:,1].std():.2f} | arc r mean {np.hypot(Pa[:,0],Pa[:,1]+11).mean():.2f} sd {np.hypot(Pa[:,0],Pa[:,1]+11).std():.2f}')
    return np.sqrt(np.mean(np.r_[rp,rg,ra]**2)), e
if __name__=="__main__":
  for W in [7.44,7.0]:
    for f in range(1100,2101,100):
        s,e=score(f,W,W/2.976); print(W,f,'field rms m',round(s,3),'goal pnp px',round(e,2)); score(f,W,W/2.976,True)
